import {CyclingPowerService} from './services/cycling-power/index.js';
import {CyclingSpeedAndCadenceService} from './services/cycling-speed-and-cadence/index.js';
import {HeartRateService} from './services/heart-rate/index.js';
import {BleServer} from '../../util/ble-server.js';
import {once} from 'events';

export const DEFAULT_NAME = 'Gymnasticon';

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

  if (manufacturerData && manufacturerData.length) {
    advertisingParts.push(buildAdStructure(AD_TYPE_MANUFACTURER_DATA, manufacturerData));
  }

  if (name) {
    const nameBuffer = Buffer.from(name);
    const nameType = nameBuffer.length <= 29 ? AD_TYPE_COMPLETE_NAME : AD_TYPE_SHORT_NAME;
    const truncated = nameBuffer.slice(0, nameBuffer.length <= 29 ? nameBuffer.length : 29);
    scanResponseParts.push(buildAdStructure(nameType, truncated));
  }

  if (includeTxPower) {
    scanResponseParts.push(buildAdStructure(AD_TYPE_TX_POWER, Buffer.from([0x00])));
  }

  const advertisementData = packStructures(advertisingParts);
  const scanData = packStructures(scanResponseParts);

  return { advertisementData, scanData };
}

export function createServices(options) {
  return [
    new CyclingPowerService(options),
    new CyclingSpeedAndCadenceService(options),
    new HeartRateService(options),
  ];
}

export class GymnasticonServer extends BleServer {
  constructor(bleno, name = DEFAULT_NAME) {
    const services = createServices();
    super(bleno, name, services);

    this.advertisingOptions = {
      connectable: true,
      scannable: true,
      includeTxPower: true,
      manufacturerData: Buffer.from([0x01]),
      serviceUuids: ['1818', '1816', '180d'],
    };
  }

  updateHeartRate(hr) {
    const hrService = this.services.find(s => s.uuid === '180d');
    if (hrService) {
      hrService.updateHeartRate(hr);
    }
  }

  async start() {
    if (this.state !== 'stopped') {
      throw new Error('already started');
    }

    this.state = 'starting';

    if (this.bleno.state !== 'poweredOn') {
      const [state] = await once(this.bleno, 'stateChange');
      if (state !== 'poweredOn') {
        this.state = 'stopped';
        throw new Error(`Bluetooth adapter failed to power on: ${state}`);
      }
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

    await this.bleno.setServicesAsync(this.services);
    this.state = 'started';
  }
}
