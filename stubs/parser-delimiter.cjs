const {Transform} = require('stream');

class DelimiterStub extends Transform {
  constructor() {
    super();
  }
}

module.exports = DelimiterStub;
module.exports.__isStub = true;
