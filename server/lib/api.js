const redis = require('redis'),
      jwcrypto = require('jwcrypto'),
      fs = require('fs'),
      util = require('util'),
      events = require('events'),
      path = require('path'),
      bid = require('./bid'),
      ALGORITHM = "RS",
      KEYSIZE = 256,
      DEFAULT_DOMAIN = 'personatestuser.org',
      ONE_HOUR_IN_MS = 60 * 60 * 1000;

// Import the jwcrypto algorithms
require('jwcrypto/lib/algs/rs');
require('jwcrypto/lib/algs/ds');

var vconf = {
  browserid: 'https://diresworb.org',
  verifier: "https://diresworb.org/verify"
};

// a place to register recently-verified emails.
var verifiedEmails = {};

function expectSoon(f, interval_ms, callback) {
  function isTrueWithinTime(elapsed_ms) {

    var found = false;
    if (f()) {
      found = true;
      return callback(true);
    }

    else if (elapsed_ms < interval_ms) {
      elapsed_ms *= 2;
      setTimeout(function() {
        isTrueWithinTime(elapsed_ms);
      }, elapsed_ms);
    }

    else {
      return callback(!! found);
    }
  }
  isTrueWithinTime(50);
};

var API = module.exports = function API(config, onready) {
  events.EventEmitter.call(this);
  var self = this;

  // get default config from env
  config = config || {
    redis_host: process.env["REDIS_HOST"] || "127.0.0.1",
    redis_port: parseInt(process.env["REDIS_PORT"] || "6379", 10)
  };

  onready = onready || function() {};

  // All our redis keys are prefixed with 'ptu:'
  //
  // ptu:nextval        = an iterator
  // ptu:mailq          = a list used as a queue from the mail daemon
  // ptu:emails:staging = zset of user emails scored by creation date
  // ptu:emails:valid   = zset of user emails scored by creation date
  // ptu:email:<email>:password = password for user with given email
  // ptu:email:<email>:session  = session context for bid transactions
  //
  // Emails start their life in staging and, if all goes well, end
  // up in ptu:emails once validated etc.  We cull both zsets
  // regularly for expired data.
  var redisClient = redis.createClient(config.redis_port, config.redis_host);

  redisClient.on('error', function(err) {
    self.emit('error', "Redis client error: " + err);
  });

  // The verifier waits for emails to arrive from the IdP asking the
  // test user to complete the registration steps in ... his? her? its?
  // account.  It takes care of the transaction with the IdP and emits
  // a 'user-created' signal, which carries the email, when an email
  // is being moved from staging to live.  At this point, account creation
  // is complete and we can use the email/password pair.
  //
  // Of course, it's possible that this process may never complete due to
  // network issues, intense solar flare activity, smurfs, etc.  So
  // getTestUser (below) will timeout and return an error if the email
  // creation has not completed within five seconds.
  var verifier = new bid.Verifier(vconf);
  verifier.startVerifyingEmails();
  verifier.on('user-created', function(email) {
    verifiedEmails[email] = true;
  });

  // XXX i would like to have a select(db, onready), but i'm getting
  // mysterious crashes from hiredis claiming that an error isn't
  // being handled (despite the above 'on error' handler)
  onready(null);

  this.getTestUser = function getTestUser(callback) {
    // pick a unique username and assign a random password.
    try {
      var name = getRandomName();
      var password = getRandomPassword();
      var email;

      self.emit('message', "Staging new user");

      redisClient.incr('ptu:nextval', function(err, val) {
        email = name + val + '@' + DEFAULT_DOMAIN;
        var created = (new Date()).getTime();
        var expires = created + ONE_HOUR_IN_MS;

        var multi = redisClient.multi();
        multi.zadd('ptu:emails:staging', expires, email);
        multi.set('ptu:email:'+email+':password', password);
        multi.exec(function(err) {
          if (err) return callback(err);
          bid.createUser(vconf, email, password, function(err) {
            if (err) return callback(err);

            // Now check periodically for the email to have appeared in
            // our verfiedEmails bucket.  Once it is there, we know the
            // creation process has completed successfully and we can
            // return an object containing the email, password, and timeout.
            // If this does not complete within 5 seconds, return error.
            expectSoon(
              (function() {
                self.emit('message', "Verifying new user");
                return verifiedEmails[email] === true;
              }),
              5000, // milliseconds
              function(it_worked) {
                if (it_worked) {
                  self.emit('message', "Verified new user");
                  // clean up
                  delete verifiedEmails[email];
                  return callback(null, {
                    'email': email,
                    'password': password,
                    'expires': expires
                  });
                } else {
                  self.emit('message', "Aw, snap.  User verification timed out.");
                  return callback("User creation timed out");
                }
              }
            );
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
      multi.del('ptu:email:'+email+':password');
      multi.del('ptu:email:'+email+':session');
      multi.zrem('ptu:emails:staging', email);
      multi.zrem('ptu:emails:valid', email);
      return multi.exec(callback);
    } catch (err) {
      return callback(err);
    }
  };

  this.getAssertion = function getAssertion(params, callback) {
    try{
      var email = params.email;
      var password = params.password;
      var audience = params.audience;
      var duration = params.duration || (60 * 60 * 1000);
      if (! email && password && audience) {
        return callback(new Error("required param missing"));
      }

      var now = new Date();
      var expiresAt = new Date(now.getTime() + duration);

      redisClient.get(email, function(err, storedPassword) {
        if (false && password !== storedPassword) {
          return callback(new Error("Password incorrect"));
        }

        // XXX wip ...
        var payload = {foo: "I assert!"};

        jwcrypto.generateKeypair(
          {algorithm: ALGORITHM, keysize: KEYSIZE},
          function(err, kp) {
            if (err) return callback(err);
            jwcrypto.assertion.sign(
              payload,
              {issuer: "personatestuser.org",
               expiresAt: expiresAt,
               audience: params.audience},
              kp.secretKey,
              function(err, assertion) {
            return callback(null, {assertion: assertion});
	      });
        });
      });
    } catch (err) {
      return callback(err);
    }
  };

  this._cullFromZset = function _cullFromZset(key, age, callback) {
    // utility function for periodicallyCullUsers
    // calls back with (err, num_culled)
    redisClient.zrangebyscore(key, '-inf', age, function(err, results) {
      if (!err && results.length) {
        var email;
        var multi = redisClient.multi();

        // for each of the users, delete the password record and remove
        // it from the emails zset.
        for (var i in results) {
          email = results[i];
          multi.del('ptu:email:'+email+':password');
          multi.del('ptu:email:'+email+':session');
          multi.zrem('ptu:emails:valid', email);
        }

        multi.exec(function(err, n) {
          if (err) {
            return callback(err);
          }
          // cull again in one minute
          return callback(null, n.length);
        });
      } else {
        // cull again in one minute
        return callback(null, 0);
      }
    });
  };

  this.periodicallyCullUsers = function periodicallyCullUsers(interval) {
    var self = this;

    // by default, cull every minute
    interval = interval || 60000;

    // make sure this only gets called once
    if (this.cullingUsers === true) return;
    this.cullingUsers = true;

    function cullUsers() {
      var now = (new Date()).getTime();
      var one_hour_ago = now - (60 *60);

      // cull from our two zsets - staging and verified emails
      self._cullFromZset('ptu:emails:staging', one_hour_ago, function(err, n) {
        if (err) self.emit('error', "Error culling from emails:staging: " + err);
        self._cullFromZset('ptu:emails:valid', one_hour_ago, function(err, n) {
          if (err) self.emit('error', "Error culling from emails: " + err);
          setTimeout(cullUsers, interval);
        });
      });
    }

    cullUsers();
  };

  this.periodicallyCullUsers();
  return this;
};
util.inherits(API, events.EventEmitter);

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
