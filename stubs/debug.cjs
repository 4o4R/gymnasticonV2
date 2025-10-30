function debug(namespace) {
  return (...args) => console.log(`${namespace}:`, ...args);
}

debug.__isStub = true;

module.exports = debug;
