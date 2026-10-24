// The suite runs on hosts where the pinned native BLE/serial stack cannot be
// built, so the deliberate stub opt-in must be in place before any test module
// (and therefore any module-scope loadDependency call) is evaluated. Static
// imports are used so the suite also runs on Node 14.
process.env.GYMNASTICON_ALLOW_STUBS = '1';
