var redis = require('redis');
var _culling = false;

  // get default config from env
var conf = {
  redis_host: process.env["REDIS_HOST"] || "127.0.0.1",
  redis_port: parseInt(process.env["REDIS_PORT"] || "6379", 10)
};

/*
 * private functions
 *
 * Utility function for periodicallyCullUsers
 * Calls back with err, numCulled.
 */
function _cullOldEmails(age, callback) {
  var cli = redis.createClient(conf.redis_port, conf.redis_host);
  var toCull = {};
  var numCulled = 0;
  var email;

  // asynchronously cull the outdated emails in valid and staging
  cli.zrangebyscore('ptu:emails:valid', '-inf', age, function(err, results) {
    if (err) return callback(err);
    results.forEach(function(email) {
      toCull[email] = true;
    });

    cli.zrangebyscore('ptu:emails:staging', '-inf', age, function(err, results) {
      if (err) return callback(err);
      results.forEach(function(email) {
        toCull[email] = true;
      });

      // we need to get the env for each email so we know how to
      // delete the account
      var multi = cli.multi();
      Object.keys(toCull).forEach(function(email) {
        multi.hget('ptu:email:'+email, 'env');
      });
      multi.exec(function(err, envs) {
        var multi = cli.multi();
        Object.keys(toCull).forEach(function(email, index) {
          // Push the email to be culled and its domain onto the expired queue.
          // The bid module will take it from there and tell the IdP to delete
          // the account.
          multi.rpush('ptu:expired', envs[index]+','+email);

          // Delete from the local datastore
          multi.del('ptu:email:'+email);
          multi.zrem('ptu:emails:staging', email);
          multi.zrem('ptu:emails:valid', email);
          numCulled ++;
          console.log("will cull expired email: " + email);
        });
        multi.exec(function(err, results) {
          if (err) {
            return callback(err);
          } else {
            if (numCulled) console.log("culled " + numCulled + " emails");
            return callback(null, numCulled);
          }
        });
      });
    });
  });
}

function periodicallyCullUsers(interval) {
  // by default, cull every minute
  interval = interval || 60000;

  // make sure this only gets called once
  if (_culling === true) return;
  _culling = true;

  function cullUsers() {
    var now = (new Date()).getTime();
    var one_hour_ago = now - (60 *60);

    _cullOldEmails(one_hour_ago, function(err, n) {
      setTimeout(cullUsers, interval);
    });
  }

  cullUsers();
}

/*
 * public interface: getRedisClient
 *
 * returns a redis client for our config.  The first client starts
 * periodic culling of expired accounts.
 */
var getRedisClient = module.exports.getRedisClient = function getRedisClient() {
  var redisClient = redis.createClient(conf.redis_port, conf.redis_host);

  redisClient.on('error', function(err) {
    console.log("ERROR: Redis client: " + err);
  });

  if (! _culling) {
    periodicallyCullUsers();
  }
  return redisClient;
};
