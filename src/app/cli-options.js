import {defaults} from './defaults.js'; // Pull pure data defaults without triggering BLE initialization.
import {getBikeTypes} from '../bikes/index.js'; // Import directly to avoid loading noble prematurely.

export const options = {
  'config': {
    describe: '<filename> load legacy options from json file',
    type: 'string',
  },
  'config-path': {
    describe: '<path> primary configuration file location',
    type: 'string',
    default: '/etc/gymnasticon.json',
  },

  'bike': {
    describe: '<type>',
    type: 'string',
    choices: getBikeTypes(),
    default: defaults.bike,
  },
  'default-bike': {
    describe: '<type> fallback bike profile when autodetect fails',
    type: 'string',
    default: defaults.defaultBike,
  },

  'bike-connect-timeout': {
    describe: '<seconds>',
    type: 'number',
    default: defaults.bikeConnectTimeout,
  },
  'bike-receive-timeout': {
    describe: '<seconds>',
    type: 'number',
    default: defaults.bikeReceiveTimeout,
  },
  'bike-adapter': {
    describe: '<name> for bike connection',
    default: defaults.bikeAdapter,
  },

  'flywheel-address': {
    describe: '<macaddr>',
  },
  'flywheel-name': {
    describe: '<name>',
  },
  'peloton-path': {
    describe: '<path> usb serial device path',
    type: 'string',
    default: defaults.pelotonPath,
  },
  'bot-power': {
    describe: '<watts> initial bot power',
    type: 'number',
    default: defaults.botPower,
  },
  'bot-cadence': {
    describe: '<rpm> initial bot cadence',
    type: 'number',
    default: defaults.botCadence,
  },
  'bot-host': {
    describe: '<host> for power/cadence control over udp',
    type: 'string',
    default: defaults.botHost,
  },
  'bot-port': {
    describe: '<port> for power/cadence control over udp',
    type: 'number',
    default: defaults.botPort,
  },

  'server-adapter': {
    describe: '<name> for app connection',
    default: defaults.serverAdapter,
  },
  'server-adapters': {
    describe: '<list> optional comma-separated adapters for BLE output mirroring',
    type: 'string',
  },
  'ble-multi-output': {
    describe: 'mirror BLE advertising across multiple adapters when available (auto when omitted)',
    type: 'boolean',
    default: defaults.bleMultiOutput,
  },
  'server-name': {
    describe: '<name> used for Bluetooth advertisement',
    default: defaults.serverName,
  },
  'server-ping-interval': {
    describe: '<seconds> ping app when user not pedaling',
    type: 'number',
    default: defaults.serverPingInterval,
  },
  'ant-device-id': {
    describe: '<id> ANT+ device id for bike power broadcast',
    type: 'number',
    default: defaults.antDeviceId,
  },
  'ant-auto': {
    describe: 'auto-enable ANT+ when a compatible stick is detected',
    type: 'boolean',
    default: defaults.antAuto,
  },
  'ant-plus': {
    describe: 'force-enable ANT+ broadcasting regardless of auto detection',
    type: 'boolean',
  },
  'power-scale': {
    describe: '<value> scale watts by this multiplier',
    type: 'number',
    default: defaults.powerScale,
  },
  'power-offset': {
    describe: '<value> add this value to watts',
    type: 'number',
    default: defaults.powerOffset,
  },
  'speed-circumference': {
    describe: '<meters> virtual wheel circumference for speed estimation',
    type: 'number',
    default: defaults.speedFallback.circumferenceM,
  },
  'speed-gear-factor': {
    describe: '<ratio> crank-to-wheel gear factor for speed estimation',
    type: 'number',
    default: defaults.speedFallback.gearFactor,
  },
  'speed-min': {
    describe: '<m/s> minimum estimated speed',
    type: 'number',
    default: defaults.speedFallback.min,
  },
  'speed-max': {
    describe: '<m/s> maximum estimated speed',
    type: 'number',
    default: defaults.speedFallback.max,
  },

  'heart-rate-device': {
    describe: '<name> optional heart-rate monitor name filter',
    type: 'string',
  },
  'heart-rate-adapter': {
    describe: '<name> optional Bluetooth adapter dedicated to heart-rate scanning',
    type: 'string',
  },
  'heart-rate-enabled': {
    describe: 'force-enable or disable heart-rate rebroadcast (auto when omitted)',
    type: 'boolean',
  },
  'power-smoothing': {
    describe: '<0-1> exponential smoothing factor for power output',
    type: 'number',
    default: 0.8,
  },
  'health-check-interval': {
    describe: '<ms> interval for health monitor checks',
    type: 'number',
    default: 5000,
  },
  'connection-timeout': {
    describe: '<ms> timeout for BLE connection attempts',
    type: 'number',
    default: 10000,
  },
  'connection-retries': {
    describe: '<count> maximum BLE connection retries',
    type: 'number',
    default: 3,
  },
  'connection-retry-delay': {
    describe: '<ms> wait before retrying bike startup after a failure',
    type: 'number',
    default: defaults.connectionRetryDelay,
  }
};
