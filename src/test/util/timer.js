import test from '../support/tape.js';
import {Timer} from '../../util/timer.js';

test('Timer keeps repeating even when a listener throws', t => {
  t.plan(1);
  // Swallow the propagated error so it doesn't fail the run; we only care that
  // the repeating timer keeps scheduling its next tick despite the throw.
  const onUncaught = () => {};
  process.on('uncaughtException', onUncaught);

  let count = 0;
  const timer = new Timer(0.01); // 10ms, repeats by default
  timer.on('timeout', () => {
    count += 1;
    throw new Error('boom');
  });
  timer.reset();

  setTimeout(() => {
    timer.cancel();
    process.removeListener('uncaughtException', onUncaught);
    t.ok(count >= 3, `timer survived throwing listener (fired ${count} times)`);
    t.end();
  }, 60);
});

test('Timer supports an immediate first tick', t => {
  t.plan(1);
  const started = Date.now();
  let fired = 0;
  const timer = new Timer(1, { immediate: true });
  timer.on('timeout', () => { fired += 1; });
  timer.reset();

  setTimeout(() => {
    timer.cancel();
    const elapsed = Date.now() - started;
    t.ok(fired >= 1 && elapsed < 900, `first tick fired immediately (fired=${fired} at ${elapsed}ms)`);
    t.end();
  }, 100);
});
