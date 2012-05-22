const redis = require('redis'),
      fs = require('fs'),
      path = require('path'),
      DEFAULT_DOMAIN = 'personatestuser.org',
      ONE_HOUR_IN_MS = 60 * 60 * 1000;

module.exports = function API(config, onready) {
  // get default config from env
  config = config || {  
    redis_host: process.env["REDIS_HOST"] || "127.0.0.1", 
    redis_port: parseInt(process.env["REDIS_PORT"] || "6379", 10)
  };

  onready = onready || function() {};

  // All our redis keys are prefixed with 'ptu:'
  //
  // ptu:nextval = an iterator
  // ptu:emails = zset of user emails scored by creation date
  // ptu:<email> = password for user with given email
  var redisClient = redis.createClient(config.redis_port, config.redis_host);

  redisClient.on('error', function(err) {
    console.log("Redis client error: " + err);
  });

  // XXX i would like to have a select(db, onready), but i'm getting
  // mysterious crashes from hiredis claiming that an error isn't 
  // being handled.  
  onready(null);

  this.getTestUser = function getTestUser(callback) {
    // pick a unique username and assign a random password.
    try {
      var name = getRandomName();
      var password = getRandomPassword();
      var email;

      redisClient.incr('ptu:nextval', function(err, val) {
        email = name + val + '@' + DEFAULT_DOMAIN;
        var created = (new Date()).getTime();
        var expires = created + ONE_HOUR_IN_MS;

        var multi = redisClient.multi();
        multi.zadd('ptu:emails', expires, email);
        multi.set('ptu:'+email, password);
        multi.exec(function(err) {
          if (err) return callback(err);
          return callback(null, {
            'email': email, 
            'password': password,
            'expires': expires
          });
        });
      });

    } catch (err) {
      return callback(err);
    }
  };

  this.deleteTestUser = function deleteTestUser(email, callback) {
    try {
      var multi = redisClient.multi();
      multi.del('ptu:'+email);
      multi.zrem('ptu:emails', email);
      multi.exec(callback);
    } catch (err) {
      return callback(err);
    }
  };

  this.getAssertion = function getAssertion(params, callback) {
    try{
      var email = params.email;
      var password = params.password;
      var audience = params.audience;
      if (! email && password && audience) {
        return callback(new Error("required param missing"));
      }

      redisClient.get(email, function(err, storedPassword) {
        if (password !== storedPassword) {
          return callback(new Error("Password incorrect"));
        }

        // make an assertion for this audience.

      });
      return callback(null, {
        'assertion': 'I like pie'
      });
    } catch (err) {
      return callback(err);
    }
  };

  this.periodicallyCullUsers = function periodicallyCullUsers(interval) {
    // by default, cull every minute
    interval = interval || 60000; 

    // make sure this only gets called once
    if (this.cullingUsers === true) return;
    this.cullingUsers = true;

    function cullUsers() {
      var now = (new Date()).getTime();
      var one_hour_ago = now - (60 *60);

      // find all users that were created over an hour ago.
      redisClient.zrangebyscore('ptu:emails', '-inf', one_hour_ago, function(err, results) {
        if (!err && results.length) {
          var email;
          var multi = redisClient.multi();

          // for each of the users, delete the password record and remove
          // it from the emails zset.
          for (var i in results) {
            email = results[i];
            multi.del('ptu:'+email);
            multi.zrem('ptu:emails', email);
          }

          multi.exec(function(err) {
            if (err) {
              console.log('error culling users: ' + err);
            } 
            // cull again in one minute
            setTimeout(cullUsers, interval);
          });
        } else {
          // cull again in one minute
          setTimeout(cullUsers, interval); 
        }
      });
    }

    cullUsers();
  };

  this.periodicallyCullUsers();
  return this;
};

// ----------------------------------------------------------------------
// Utils for this module

var names = [
  'abel',
  'abreu',
  'acevedo',
  'adrian',
  'aguilera',
  'alexis',
  'andy',
  'angelo',
  'anthony',
  'ashley',
  'avellanet',
  'blass',
  'blazquez',
  'cancel',
  'carlos',
  'cesar',
  'charlie',
  'daniel',
  'didier',
  'edward',
  'farrait',
  'fernando',
  'galindo',
  'garcia',
  'gomez',
  'grullon',
  'hernandez',
  'johnny',
  'jonathan',
  'lopez',
  'lozada',
  'martin',
  'masso',
  'melendez',
  'miguel',
  'montenegro',
  'nefty',
  'olivares',
  'oscar',
  'ralphy',
  'rawy',
  'ray',
  'raymond',
  'rene',
  'reyes',
  'ricky',
  'robert',
  'robi',
  'rodriguez',
  'rosa',
  'rossello',
  'roy',
  'ruben',
  'ruiz',
  'sallaberry',
  'serbia',
  'sergio',
  'talamantez',
  'torres',
  'weider',
  'xavier'];

var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ' +
            'abcdefghijklmnopqrstuvwxyz' +
            '1234567890' +
            '~#$%^&*(){}[]_+-=,.;:';

var numNames = names.length;
var numChars = chars.length;

function getRandomName() {
  return names[Math.floor(Math.random() * numNames)];
}

function getRandomPassword(length) {
  length = length || 16;

  var i,
      password = '';

  for (i = 0; i < length; i++) {
    password += chars[Math.floor(Math.random() * numChars)];
  }
  return password;
}

