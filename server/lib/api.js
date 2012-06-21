const jwcrypto = require('jwcrypto'),
      fs = require('fs'),
      util = require('util'),
      url = require('url'),
      events = require('events'),
      path = require('path'),
      bid = require('./bid'),
      getRedisClient = require('./db').getRedisClient,
      vconf = require('./vconf'),
      ALGORITHM = "RS",
      KEYSIZE = 256,
      ONE_HOUR_IN_MS = 60 * 60 * 1000;

// Import the jwcrypto algorithms
require('jwcrypto/lib/algs/rs');
require('jwcrypto/lib/algs/ds');

const DEFAULT_DOMAIN =
  (process.env.PUBLIC_URL ? url.parse(process.env.PUBLIC_URL).hostname :
   'personatestuser.org');

console.log('my domain is:', DEFAULT_DOMAIN);

var verifier = new bid.Verifier(vconf);
verifier.startVerifyingEmails();

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

  onready = onready || function() {};

  // All our redis keys are prefixed with 'ptu:'
  //
  // ptu:nextval        = an iterator
  // ptu:mailq          = a list used as a queue from the mail daemon
  // ptu:emails:staging = zset of user emails scored by creation date
  // ptu:emails:valid   = zset of user emails scored by creation date
  // ptu:email:<email>  = hash containing password, session, and env
  //
  // Emails start their life in staging and, if all goes well, end
  // up in ptu:emails once validated etc.  We cull both zsets
  // regularly for expired data.



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
  verifier.on('error', function(err) {
    console.log("Verifier ERROR: " + err);
  });
  verifier.on('user-created', function(email) {
    verifiedEmails[email] = true;
  });

  // XXX i would like to have a select(db, onready), but i'm getting
  // mysterious crashes from hiredis claiming that an error isn't
  // being handled (despite the above 'on error' handler)
  onready(null);

  this.getTestUser = function getTestUser(serverEnv, callback) {
    // pick a unique username and assign a random password.
    try {
      var name = getRandomName();
      var password = getRandomPassword();
      // we will assign the exact email below
      var email;

      console.log("in getTestUser");

      self.emit('message', "Staging new user");

      getRedisClient().incr('ptu:nextval', function(err, val) {
        email = name + val + '@' + DEFAULT_DOMAIN;
        var created = (new Date()).getTime();
        var expires = created + ONE_HOUR_IN_MS;

        console.log("getTestUser: email = " + email);

        var multi = getRedisClient.multi();
        multi.zadd('ptu:emails:staging', expires, email);
        // save the expiration date in the hash, so we don't have to
        // look it up in the zsets.  Saves a redis call round-trip.
        multi.hmset('ptu:email:'+email, {
                      email: email,
                      password: password,
                      env: serverEnv,
                      expires: expires
                    });
        multi.exec(function(err) {

          console.log("getTestUser: stage " + email + " with err =  " +err);
          if (err) return callback(err);
          bid.createUser(vconf[serverEnv], email, password, function(err) {
            console.log("getTestUser: in callback from bid.createUser; err = " + err);
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
                  console.log("getTestUser: SUCCESS! verified " + email);
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
      var multi = getRedisClient.multi();
      multi.del('ptu:email:'+email);
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

      getRedisClient.get(email, function(err, storedPassword) {
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

  /*
   * Utility function for periodicallyCullUsers
   * Calls back with err, numCulled.
   */
  this._cullOldEmails = function _cullFromStore(age, callback) {
    var cli = getRedisClient();
    var toCull = {};
    var numCulled = 0;
    var email;

    // asynchronously cull the outdated emails in valid and staging
    cli.getRedisClient.zrangebyscore('ptu:emails:valid', '-inf', age, function(err, results) {
      if (err) return callback(err);
      results.forEach(function(email) {
        toCull[email] = true;
      });

      cli.getRedisClient.zrangebyscore('ptu:emails:staging', '-inf', age, function(err, results) {
        if (err) return callback(err);
        results.forEach(function(email) {
          toCull[email] = true;
        });

        var multi = cli.multi();
        Object.keys(toCull).forEach(function(email) {
          multi.del('ptu:email:'+email);
          multi.zrem('ptu:emails:staging', email);
          multi.zrem('ptu:emails:valid', email);
          numCulled ++;
          console.log("will cull " + email);
        });
        multi.exec(function(err, results) {
          if (err) {
            return callback(err);
          } else {
            console.log("culled " + numCulled + " emails");
            return callback(null, numCulled);
          }
        });
      });
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

      self._cullOldEmails(one_hour_ago, function(err, n) {
        setTimeout(cullUsers, interval);
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
