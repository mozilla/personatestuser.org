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
  // ptu:email:<email>  = hash containing most or all of:
  //                      email     the redis email key
  //                      password  password for email account
  //                      session   IdP session (JSON string)
  //                      token     verifier token (JSON string)
  //                      env       server env (prod, dev, stage)
  //                      do_verify flag
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
  // network issues, intense solar flare activity, frisky smurfs, etc.  So
  // getVerifiedEmail (below) will timeout and return an error if the email
  // creation has not completed within five seconds.
  this.verifier = new bid.Verifier(vconf);
  this.availableEmails = {};
  this.verifier.startVerifyingEmails();
  this.verifier.on('error', function(err) {
    console.log("Verifier ERROR: " + err);
  });
  this.verifier.on('user-ready', function(email, token) {
    self.availableEmails[email] = token || true;
  });

  // XXX i would like to have a select(db, onready), but i'm getting
  // mysterious crashes from hiredis claiming that an error isn't
  // being handled (despite the above 'on error' handler)
  onready(null);

  this.generateNewEmail = function generateNewEmail(serverEnv, callback) {
    var name = getRandomName();
    var password = getRandomPassword();
    // we will assign the exact email below
    var email;

    getRedisClient().incr('ptu:nextval', function(err, val) {
      email = name + val + '@' + DEFAULT_DOMAIN;
      var expires = (new Date()).getTime() + ONE_HOUR_IN_MS;
      var data = {
        email: email,
        password: password,
        expires: expires,
        env: serverEnv
      };
      var multi = getRedisClient().multi();
      multi.zadd('ptu:emails:staging', expires, email);
      multi.hmset('ptu:email:'+email, data);
      multi.exec(function(err) {
        if (err) return callback(err);
        return callback(null, data);
      });
    });
  };

  this.waitForEmail = function waitForEmail(email, callback) {
    expectSoon(
      function() {
        self.emit('message', "Awaiting " + email);
          return (!! self.availableEmails[email]);
        },
        5000, // milliseconds,
        function(it_worked) {
          if (it_worked) {
            self.emit('message', "Received " + email);
            getRedisClient().hgetall('ptu:email:'+email, callback);
          } else {
            self.emit('error', "Timed out waiting for " + email);
            callback("Timed out waiting for " + email);
          }
        }
    );
  };

  this._getEmail = function _getEmail(serverEnv, callback) {
    self.generateNewEmail(serverEnv, function(err, data) {
      if (err) return callback(err);
      getRedisClient().hset('ptu:email:'+data.email, 'do_verify', 'no', function(err1) {
        bid.createUser(vconf[serverEnv], data.email, data.password, function(err2) {
          if (err1 || err2) {
            return callback(err1 || err2);
          } else {
            return callback(null, data.email);
          }
        });
      });
    });
  };

  /*
   * getUnverifiedEmail - get a username and password, and stage it
   * with our IdP.  Don't complete the user creation; return the
   * creation url.
   */
  this.getUnverifiedEmail = function getUnverifiedEmail(serverEnv, callback) {
    this._getEmail(serverEnv, function(err, email) {
      self.waitForEmail(email, function(err, emailData) {
        if (err) {
          return callback(err);
        } else {
          return callback(null, {
            email: emailData.email,
            password: emailData.password,
            token: emailData.token,
            expires: emailData.expires,
            env: emailData.env
          });
        }
      });
    });
  };

  /*
   * getVerifiedEmail - stage a new email and password, and verify it
   * with our IdP.  Callback with the verified email info.  If
   * verification takes longer than 5 seconds, consider that it's
   * timed out and call back with an error.
   */
  this.getVerifiedEmail = function getVerifiedEmail(serverEnv, callback) {
    this._getEmail(serverEnv, function(err, email) {
      self.waitForEmail(email, function(err, emailData) {
        if (err) {
          return callback(err);
        } else {
          // With a verified email, we don't send back the
          // already-used verification token.
          return callback(null, {
            email: emailData.email,
            password: emailData.password,
            expires: emailData.expires,
            env: emailData.env
          });
        }
      });
    });
  };

  this.deleteTestUser = function deleteTestUser(email, callback) {
    try {
      var multi = getRedisClient().multi();
      multi.del('ptu:email:'+email);
      multi.zrem('ptu:emails:staging', email);
      multi.zrem('ptu:emails:valid', email);
      return multi.exec(callback);
    } catch (err) {
      return callback(err);
    }
  };

  this.generateKeypair = function genKeyPair(params, callback) {
    if (!params.email) {
      return callback("params missing required email");
    }
    jwcrypto.generateKeypair({algorithm:ALGORITHM, keysize:KEYSIZE}, function(err, kp) {
      getRedisClient().hmset('ptu:email:'+params.email, {
        publicKey: kp.publicKey.serialize(),
        secretKey: kp.secretKey.serialize()
      }, function(err) {
        return callback(err, kp);
      });
    });
  };

  this.getAssertion = function getAssertion(params, audience, callback) {
    var email = params.email;
    var password = params.password;
    var duration = params.duration || (60 * 60 * 1000);
    var serverEnv = vconf[params.env];
    if (! (email && password && audience && serverEnv)) {
      return callback(new Error("required param missing"));
    }

    var now = new Date();
    var expiresAt = new Date(now.getTime() + duration);

    getRedisClient().hgetall('ptu:email:'+email, function(err, userData) {
      if (password !== userData.password) {
        return callback(new Error("Password incorrect"));
      }

      self.generateKeypair(params, function(err, kp) {
        bid.certifyKey(serverEnv, email, kp.publicKey, function(err, cert) {
          return callback(null, cert);
        });
      });
    });
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
            if (numCulled) console.log("culled " + numCulled + " emails");
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
