const vows = require("vows"),
      assert = require("assert"),
      api = require("../server/lib/api"),
      redis = require('redis');

vows.describe("API vows")

// XXX spin up a test redis for this

.addBatch({
  "getTestUser": {
    topic: function() {
      api.getTestUser(this.callback);
    },

    "gives us a valid email and password": function(data) {
      assert(data.email.indexOf('@') > 0);
      assert(data.password.length >= 16);
    }, 
    
    "stores the email and password": { 
      topic: function(data) {
        var multi = redis.createClient().multi();
        var cb = this.callback;
        multi.zrank('ptu:emails', data.email);
        multi.get('ptu:'+data.email);
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
            multi.zrank('ptu:emails', data.email);
            multi.get('ptu:'+data.email);
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
