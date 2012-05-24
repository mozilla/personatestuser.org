const vows = require("vows"),
      assert = require("assert"),
      bid = require("../lib/bid");

const config = {
  browserid: 'https://diresworb.org',
  verifier: 'https://diresworb.org/verify'
}

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
      }
      bid.getSessionContext(config, context, function(err, res) {
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
        bid.getAddressInfo(config, context, function(err, res) {
          cb(err, context);
        });
      },

      "works": function(err, context) {
        assert(err === null);
        assert(typeof context.address_info === 'object');
      },

      "and stage_user": {
        topic: function(res, context) {
          var cb = this.callback;
          bid.stageUser(config, context, function(err, res) {
            cb(err, res, context);
          });
        },

        "is 200 ok": function(err, res, context) {
          assert(err === null);
          assert(res.code === 200);
        }
      }
    }
  }
})

.export(module);
