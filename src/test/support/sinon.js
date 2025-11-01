import {createRequire} from 'module';

const require = createRequire(import.meta.url);

let sinon;
try {
  sinon = require('sinon');
  if (sinon && typeof sinon === 'object' && 'default' in sinon) {
    sinon = sinon.default;
  }
} catch (error) {
  throw new Error(
    "Cannot load the 'sinon' package. Install development dependencies first: npm install --include=dev"
  );
}

export default sinon;
