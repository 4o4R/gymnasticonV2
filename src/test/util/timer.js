import test from '../support/tape.js';
import {Timer} from '../../util/timer.js';

test('Timer keeps repeating even when a listener throws', t => {
  t.plan(1);
  const originalConsoleError = console.error;
  console.error = () => {};

  let count = 0;
  const timer = new Timer(0.01); // 10ms, repeats by default
  timer.on('timeout', () => {
    count += 1;
    throw new Error('boom');
  });
  timer.reset();

  setTimeout(() => {
    timer.cancel();
    console.error = originalConsoleError;
    t.ok(count >= 3, `timer survived throwing listener (fired ${count} times)`);
    t.end();
  }, 60);
});

test('Timer contains a listener exception', t => {
  const timer = new Timer(1, {repeats: false});
  const originalConsoleError = console.error;
  let logged = 0;
  console.error = () => { logged += 1; };
  timer.on('timeout', () => {
    throw new Error('boom');
  });

  t.doesNotThrow(() => timer.onExpire(), 'listener error does not escape the timer');
  console.error = originalConsoleError;
  t.equal(logged, 1, 'listener error is logged once');
  t.end();
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
