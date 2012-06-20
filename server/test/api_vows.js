const vows = require("vows"),
      assert = require("assert"),
      API = require("../lib/api"),
      redis = require('redis');

var api = null;

// XXX to-do: spin up a new redis instance for these tests
// and point the config to it
var config = {
  redis_host: "127.0.0.1",
  redis_port: 6379,
  redis_db: 0
};

vows.describe("API vows")

.addBatch({
  "We have an api": {
    topic: function() {
      // api creation is asynchronous because we must wait for it
      // to select the config redis_db
      var cb = this.callback;
      api = new API(config, function(err) {
        // The first return value is intercepted and checked by vows.js
        // as err from this callback.  It is not passed on to any tests.
        // To avoid the confusing uncertainty of passing two nulls and
        // testing that the result is 'null', wrap the actual err in
        // an object.
        return cb(null, {err: err});
      });
    },

    "and it is adorable": function(result) {
      assert(result.err === null);
    }
  }
})

.addBatch({
  "getTestUser": {
    topic: function() {
     api.getTestUser(this.callback);
    },

    "gives us a valid email and password": function(data) {
      assert(data.expires > (new Date()).getTime());
      assert(data.email.indexOf('@') > 0);
      assert(data.password.length >= 16);
    },

    "stores the email and password": {
      topic: function(data) {
        var multi = redis.createClient().multi();
        var cb = this.callback;
        multi.zrank('ptu:emails:valid', data.email);
        multi.get('ptu:email:'+data.email+':password');
        multi.exec(function(err, results) {
          return cb(err, data, results);
        });
      },

      "in redis": function(err, initialData, redisResults) {
        assert(err === null);
        assert(redisResults[0] >= 0);
        assert(redisResults[1] === initialData.password);
      },

      "which we can delete": {
        topic: function(data) {
          var cb = this.callback;
          api.deleteTestUser(data.email, function(err) {
            if (err) return cb(err);
            var multi = redis.createClient().multi();
            multi.zrank('ptu:emails:valid', data.email);
            multi.get('ptu:email:'+data.email+':password');
            multi.exec(function(err, results) {
              return cb(err, data, results);
            });
          });
        },

        "from redis": function(err, initialData, redisResults) {
          assert(err === null);
          assert(redisResults[0] === null);
          assert(redisResults[1] === null);
        }

      }
    },

  }
})

.export(module);
