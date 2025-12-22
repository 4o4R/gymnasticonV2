import {CyclingPowerService} from './services/cycling-power/index.js'; // Import the CPS implementation so we can notify power changes.
import {CyclingSpeedAndCadenceService} from './services/cycling-speed-and-cadence/index.js'; // Import CSC service for wheel/crank updates.
import {BleServer} from '../../util/ble-server.js'; // Base helper that wires our bleno services together.
import {once} from 'events'; // Used to await bleno state changes before advertising.
import {HeartRateService} from './services/heart-rate/index.js'; // Import HR service to forward heart rate metrics.

export const DEFAULT_NAME = 'GymnasticonV2';

const AD_TYPE_FLAGS = 0x01;
const AD_TYPE_COMPLETE_16BIT_UUIDS = 0x03;
const AD_TYPE_COMPLETE_32BIT_UUIDS = 0x05;
const AD_TYPE_COMPLETE_128BIT_UUIDS = 0x07;
const AD_TYPE_MANUFACTURER_DATA = 0xff;
const AD_TYPE_COMPLETE_NAME = 0x09;
const AD_TYPE_SHORT_NAME = 0x08;
const AD_TYPE_TX_POWER = 0x0a;

function encodeUuid(uuid) {
  const normalized = uuid.replace(/[^a-fA-F0-9]/g, '').toLowerCase();
  if (normalized.length === 4) {
    const value = Buffer.from(normalized, 'hex');
    return { type: AD_TYPE_COMPLETE_16BIT_UUIDS, data: Buffer.from([value[1], value[0]]) };
  }
  if (normalized.length === 8) {
    const value = Buffer.from(normalized, 'hex');
    return { type: AD_TYPE_COMPLETE_32BIT_UUIDS, data: Buffer.from(value).reverse() };
  }
  if (normalized.length === 32) {
    const value = Buffer.from(normalized, 'hex');
    return { type: AD_TYPE_COMPLETE_128BIT_UUIDS, data: Buffer.from(value).reverse() };
  }
  throw new Error(`Unsupported UUID length for advertising: ${uuid}`);
}

function buildAdStructure(type, data) {
  const length = data.length + 1;
  return Buffer.concat([Buffer.from([length, type]), data]);
}

function packStructures(structures) {
  const MAX_LENGTH = 31;
  const buffers = [];
  let total = 0;

  for (const structure of structures) {
    if (!structure || !structure.length) continue;
    if (total + structure.length > MAX_LENGTH) break;
    buffers.push(structure);
    total += structure.length;
  }

  return buffers.length ? Buffer.concat(buffers, total) : Buffer.alloc(0);
}

function buildAdvertisingPayload(name, options, uuids) {
  const { manufacturerData, includeTxPower, serviceUuids = uuids } = options ?? {};
  const advertisingParts = [];
  const scanResponseParts = [];

  advertisingParts.push(buildAdStructure(AD_TYPE_FLAGS, Buffer.from([0x06])));

  const uuidGroups = {};
  serviceUuids.forEach((uuid) => {
    const { type, data } = encodeUuid(uuid);
    if (!uuidGroups[type]) uuidGroups[type] = [];
    uuidGroups[type].push(data);
  });

  Object.entries(uuidGroups).forEach(([type, buffers]) => {
    advertisingParts.push(buildAdStructure(Number(type), Buffer.concat(buffers)));
  });

  // Always include a short name in the advertising payload so passive scanners/apps show the custom name.
  // Use a compact short name to stay within the 31-byte limit alongside flags/UUIDs.
  if (name) {
    const nameBuffer = Buffer.from(name);
    const shortName = nameBuffer.slice(0, 10); // Short name for advertising payload.
    advertisingParts.push(buildAdStructure(AD_TYPE_SHORT_NAME, shortName));
    // Full name goes into the scan response for devices that perform active scans.
    const fullName = nameBuffer.slice(0, 29);
    const nameType = fullName.length < nameBuffer.length ? AD_TYPE_SHORT_NAME : AD_TYPE_COMPLETE_NAME;
    scanResponseParts.push(buildAdStructure(nameType, fullName));
  }

  if (manufacturerData && manufacturerData.length) {
    advertisingParts.push(buildAdStructure(AD_TYPE_MANUFACTURER_DATA, manufacturerData));
  }

  if (includeTxPower) {
    scanResponseParts.push(buildAdStructure(AD_TYPE_TX_POWER, Buffer.from([0x00])));
  }

  const advertisementData = packStructures(advertisingParts);
  const scanData = packStructures(scanResponseParts);

  return { advertisementData, scanData };
}

export function createServices({ includeHeartRate = true } = {}) { // Factory that builds the standard Gymnasticon service list.
  const services = [
    new CyclingPowerService(), // Cycling Power Service (UUID 1818).
    new CyclingSpeedAndCadenceService(), // Cycling Speed and Cadence Service (UUID 1816).
  ];
  if (includeHeartRate) { // Teaching note: only include HR when we intend to rebroadcast it.
    services.push(new HeartRateService()); // Heart Rate Service (UUID 180d).
  }
  return services;
}

export class GymnasticonServer extends BleServer {
  constructor(bleno, name = DEFAULT_NAME, options = {}) {
    const services = createServices({ includeHeartRate: options.includeHeartRate }); // Instantiate services before handing them to the base BleServer.
    super(bleno, name, services);

    this.cpsService = services.find(service => service.uuid === '1818'); // Cache the CPS instance for quick lookups.
    this.cscService = services.find(service => service.uuid === '1816'); // Cache the CSC instance so we can update features dynamically.
    this.hrService = services.find(service => service.uuid === '180d'); // Cache the HR service to forward sensor data efficiently.
    this.cscCapabilities = { supportWheel: false, supportCrank: true }; // Track which optional CSC fields we currently advertise.
    // Teaching note: rely on bleno's standard startAdvertising path so we match
    // the proven behavior in the original ptx2 project.
    this.advertisingOptions = null;
  }

  updateHeartRate(hr) { // Push heart rate notifications to subscribed clients.
    if (!this.hrService) { // Bail out silently if the service has been removed or failed to initialize.
      return;
    }
    this.hrService.updateHeartRate(hr); // Delegate encoding to the service implementation.
  }

  updatePower(payload) { // Broadcast a Cycling Power Service measurement.
    if (!this.cpsService) { // Skip when CPS is unavailable.
      return;
    }
    this.cpsService.updateMeasurement(payload); // Let the CPS service handle characteristic encoding.
  }

  ensureCscCapabilities(capabilities) { // Update the CSC feature characteristic when wheel support toggles.
    if (!this.cscService) { // No CSC service means nothing to update.
      return;
    }
    const wheel = !!capabilities?.supportWheel; // Normalize wheel capability to a boolean.
    const crank = !!capabilities?.supportCrank; // Normalize crank capability likewise.
    if (wheel === this.cscCapabilities.supportWheel && crank === this.cscCapabilities.supportCrank) { // Skip when the feature bits are unchanged.
      return;
    }
    this.cscCapabilities = { supportWheel: wheel, supportCrank: crank }; // Persist the new capability state.
    this.cscService.ensureCapabilities(this.cscCapabilities); // Tell the CSC service to refresh its feature characteristic.
  }

  updateCsc(measurement) { // Forward CSC measurement payloads to the characteristic.
    if (!this.cscService) { // Skip if CSC is disabled.
      return;
    }
    this.cscService.updateMeasurement(measurement); // Delegate BLE encoding to the service.
  }

  async start() {
    if (this.state !== 'stopped') {
      throw new Error('already started');
    }

    this.state = 'starting';

    let state = this.bleno.state;
    const fatalStates = new Set(['unauthorized', 'unsupported']);
    while (state !== 'poweredOn') {
      if (state && fatalStates.has(state)) {
        this.state = 'stopped';
        throw new Error(`Bluetooth adapter failed to power on: ${state}`);
      }
      const [next] = await once(this.bleno, 'stateChange');
      state = next;
    }

    if (this.advertisingOptions) {
      const { advertisementData, scanData } = buildAdvertisingPayload(this.name, this.advertisingOptions, this.uuids);
      await new Promise((resolve, reject) => {
        this.bleno.startAdvertisingWithEIRData(advertisementData, scanData, (err) => {
          if (err) {
            this.state = 'stopped';
            return reject(err);
          }
          resolve();
        });
      });
    } else {
      await this.bleno.startAdvertisingAsync(this.name, this.uuids);
    }

    await this.bleno.setServicesAsync(this.services); // Commit the service list to the adapter now that advertising is live.
    this.state = 'started';
  }
}
