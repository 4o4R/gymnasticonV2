import {createRequire} from 'module';

const require = createRequire(import.meta.url);
const tape = require('tape');

export default tape;
export const test = tape;
export const onFinish = tape.onFinish.bind(tape);
