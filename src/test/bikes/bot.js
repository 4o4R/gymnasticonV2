import test from '../support/tape.js';
import {BotBikeClient} from '../../bikes/bot.js';

test('bot ignores malformed UDP messages without crashing', t => {
  t.plan(3);
  const bot = new BotBikeClient(100, 80, '0.0.0.0', 0);
  // JSON.parse fails -> the handler bails out instead of destructuring undefined.
  t.doesNotThrow(() => bot.onUdpMessage(Buffer.from('not json')));
  t.equal(bot.power, 100, 'power unchanged after bad message');
  t.equal(bot.cadence, 80, 'cadence unchanged after bad message');
  bot.disconnect();
});

test('bot ignores JSON null and non-object messages', t => {
  t.plan(2);
  const bot = new BotBikeClient(100, 80, '0.0.0.0', 0);
  t.doesNotThrow(() => bot.onUdpMessage(Buffer.from('null')));
  t.equal(bot.power, 100, 'power unchanged after null message');
  bot.disconnect();
});

test('bot applies valid UDP control messages', t => {
  t.plan(2);
  const bot = new BotBikeClient(100, 80, '0.0.0.0', 0);
  bot.onUdpMessage(Buffer.from('{"power":150,"cadence":90}'));
  t.equal(bot.power, 150, 'power updated');
  t.equal(bot.cadence, 90, 'cadence updated');
  bot.disconnect();
});
