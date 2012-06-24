const redis = require('redis'),
      unixTime = require('./time').unixTime,
      ONE_MIN_IN_SECONDS = 60,
      ONE_HOUR_IN_SECONDS = 60 * ONE_MIN_IN_SECONDS;

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
        multi.hmget('ptu:email:'+email, 'env', 'context');
      });
      multi.exec(function(err, contexts) {
        var multi = cli.multi();
        Object.keys(toCull).forEach(function(email, index) {
          // Push the email to be culled and its domain onto the expired queue.
          // The bid module will take it from there and tell the IdP to delete
          // the account.

          // The data will actually be delete by bid.cancelAccount
          // Which indicates that these functions belong back in the bid module ...
          multi.rpush('ptu:expired', JSON.stringify(contexts[index]));
          numCulled ++;
          console.log("expired email: " + email);
        });
        multi.exec(function(err, results) {
          if (err) {
            return callback(err);
          } else {
            return callback(null);
          }
        });
      });
    });
  });
}

function periodicallyCullUsers(interval) {
  // by default, cull every minute
  interval = interval || ONE_MIN_IN_SECONDS;

  // make sure this only gets called once
  if (_culling === true) return;
  _culling = true;

  function cullUsers() {
    var one_hour_ago = unixTime() - ONE_HOUR_IN_SECONDS;

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
