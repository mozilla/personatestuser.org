var vows = require("vows");
var assert = require("assert");

vows.describe("API vows")

.addBatch({
  "Test suites": {
    topic: 42, 

    "are functional": function(meaning) { 
      assert(meaning === 42);
    }
  }
})

.export(module);
