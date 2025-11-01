import '../src/test/app/simulation.js';
import '../src/test/bikes/flywheel.js';
import '../src/test/bikes/ic4.js';
import '../src/test/bikes/keiser.js';
import '../src/test/bikes/peloton.js';
import '../src/test/util/ble-scan.js';
import '../src/test/util/dropout-filter.js';
import '../src/test/util/mac-address.js';

import tape from '../src/test/support/tape.js';

await new Promise(resolve => tape.onFinish(resolve));
