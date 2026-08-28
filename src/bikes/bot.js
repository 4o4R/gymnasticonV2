import dgram from 'dgram';
import {once, EventEmitter} from 'events';
import {Timer} from '../util/timer.js';

/**
 * Pretends to be a real bike riding at a given fixed cadence and power.
 * The cadence and power can be changed on-the-fly over a UDP socket.
 * Useful for testing without having to use a real bike.
 */
export class BotBikeClient extends EventEmitter {
  /**
   * Create a BotBikeClient instance.
   * @param {number} power - initial power (watts)
   * @param {number} cadence - initial cadence (rpm)
   * @param {string} host - host to listen on for udp control interface
   * @param {number} port - port to listen on for udp control interface
   */
  constructor(power, cadence, host, port) {
    super();

    this.onStatsUpdate = this.onStatsUpdate.bind(this);
    this.onUdpError = this.onUdpError.bind(this);
    this.onUdpMessage = this.onUdpMessage.bind(this);

    this.power = power;
    this.cadence = cadence;
    this._host = host;
    this._port = port;

    this._address = '00:00:00:00:00:00';

    this._timer = new Timer(1);
    this._timer.on('timeout', this.onStatsUpdate);

    this._udpServer = dgram.createSocket('udp4');
    this._udpServer.on('message', this.onUdpMessage);
    this._udpServer.on('error', this.onUdpError);
  }

  async connect() {
    this._udpServer.bind(this._port, this._host);
    this._timer.reset();
    await once(this._udpServer, 'listening');
  }

  get address() {
    return this._address;
  }

  /**
   * @private
   */
  onStatsUpdate() {
    const {power, cadence} = this;
    this.emit('stats', {power, cadence});
  }

  /**
   * @private
   */
  onUdpMessage(msg) {
    let j;
    try {
      j = JSON.parse(msg);
    } catch (e) {
      // Teaching note: a non-JSON packet must not crash the service - bail out
      // of the handler instead of destructuring an undefined value later.
      console.error('bot control: ignoring invalid JSON:', msg.toString());
      return;
    }
    if (!j || typeof j !== 'object') {
      console.error('bot control: ignoring non-object message:', msg.toString());
      return;
    }
    const {power, cadence} = j;
    if (Number.isInteger(power) && power >= 0) {
      this.power = power;
    }
    if (Number.isInteger(cadence) && cadence >= 0) {
      this.cadence = cadence;
    }
  }

  /**
   * @private
   */
  onUdpError(err) {
    console.error('bot control: UDP socket error:', err && err.message);
    this.disconnect();
  }

  /**
   * Tear down the UDP socket and stats timer so the app can reconnect without
   * leaving the port bound (EADDRINUSE) or a timer running forever.
   */
  disconnect() {
    if (this._timer) {
      this._timer.cancel();
    }
    if (this._udpServer) {
      this._udpServer.removeAllListeners('message');
      this._udpServer.removeAllListeners('error');
      try {
        this._udpServer.close();
      } catch (e) {
        // socket may already be closed
      }
      this._udpServer = null;
    }
    this.emit('disconnect', {address: this._address});
  }
}
