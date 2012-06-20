const vows = require("vows"),
      assert = require("assert"),
      bid = require("../lib/bid");

const config = {
  browserid: 'https://diresworb.org',
  verifier: 'https://diresworb.org/verify'
};

vows.describe("BID API vows")

.addBatch({
  "Calling session_context": {
    topic: function() {
      var cb = this.callback;
      var email = 'first@foo.gov';
      var pass = 'i like pie';
      var context = {
        email: email,
        pass: pass,
        site: 'http://localhost'
      };
      bid.getSessionContext(config, context, function(err) {
        cb(err, context);
      });
    },

    "retrieves necessary tokens": function(err, context) {
      assert(err === null);
      assert(typeof context.csrf_token === 'string');
      assert(typeof context.cookieJar === 'object');
      assert(context.email === 'first@foo.gov');
    },

    "and address_info": {
      topic: function(context) {
        var cb = this.callback;
        bid.getAddressInfo(config, context, function(err) {
          cb(err, context);
        });
      },

      "works": function(err, context) {
        assert(err === null);
        assert(typeof context.address_info === 'object');
      },

      "and stage_user": {
        topic: function(context) {
          var cb = this.callback;
          bid.stageUser(config, context, function(err) {
            cb(null, {err: err});
          });
        },

        "works": function(err, result) {
          assert(result.err === null);
        }
      }
    }
  }
})

.export(module);
