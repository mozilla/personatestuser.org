const jwcrypto = require('jwcrypto'),
      fs = require('fs'),
      util = require('util'),
      url = require('url'),
      events = require('events'),
      path = require('path'),
      bid = require('./bid'),
      unixTime = require('./time').unixTime,
      redis = require('redis'),
      redisConf = require('./config'),
      vconf = require('./vconf'),
      ALGORITHM = "RS",
      KEYSIZE = 256,
      ONE_MIN_IN_SECONDS = 60,
      ONE_HOUR_IN_SECONDS= 60 * 60;

var _culling = false;


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
  this._alreadyCulling = false;
  var self = this;

  onready = onready || function() {};

  // All our redis keys are prefixed with 'ptu:'
  //
  // ptu:nextval        = an iterator
  // ptu:mailq          = a list used as a queue from the mail daemon
  // ptu:expired        = a list of expired emails and their domains
  // ptu:emails:staging = zset of user emails scored by creation date
  // ptu:emails:valid   = zset of user emails scored by creation date
  // ptu:email:<email>  = hash containing most or all of:
  //                      email     the redis email key
  //                      password  password for email account
  //                      context   IdP wsapi context (JSON string)
  //                      token     verifier token (JSON string)
  //                      env       server env (prod, dev, stage)
  //                      do_verify flag
  //
  // Emails start their life in staging and, if all goes well, end
  // up in ptu:emails once validated etc.  We cull both zsets
  // regularly for expired data.

  this._cullOldEmails = function _cullOldEmails(age, callback) {
    var toCull = {};
    var numCulled = 0;
    var email;

    // asynchronously cull the outdated emails in valid and staging
    redis.createClient().zrangebyscore('ptu:emails:valid', '-inf', age, function(err, results) {
      if (err) return callback(err);
      results.forEach(function(email) {
        toCull[email] = true;
      });

      redis.createClient().zrangebyscore('ptu:emails:staging', '-inf', age, function(err, results) {
        if (err) return callback(err);
        results.forEach(function(email) {
          toCull[email] = true;
        });

        // we need to get the env for each email so we know how to
        // delete the account
        var multi = redis.createClient().multi();
        Object.keys(toCull).forEach(function(email) {
          multi.hmget('ptu:email:'+email, 'env', 'context');
        });
        multi.exec(function(err, contexts) {
          var multi = redis.createClient().multi();
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
  ;}

  this._periodicallyCullUsers = function _periodicallyCullUsers(interval) {
    // by default, cull every minute
    interval = interval || ONE_MIN_IN_SECONDS;

    // make sure this only gets called once
    if (this._alreadyCulling === true) return;
    this._alreadyCulling = true;

    function cullUsers() {
      var one_hour_ago = unixTime() - ONE_HOUR_IN_SECONDS;

      self._cullOldEmails(one_hour_ago, function(err, n) {
        setTimeout(cullUsers, interval);
      });
    }

    cullUsers();
  };


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

  this._generateNewEmail = function _generateNewEmail(serverEnv, callback) {
    var name = getRandomName();
    var pass = getRandomPassword();
    // we will assign the exact email below
    var email;

    redis.createClient().incr('ptu:nextval', function(err, val) {
      email = name + val + '@' + DEFAULT_DOMAIN;
      var expires = unixTime() + ONE_HOUR_IN_SECONDS;
      var data = {
        email: email,
        pass: pass,
        expires: expires,
        env: serverEnv
      };
      var multi = redis.createClient().multi();
      multi.zadd('ptu:emails:staging', expires, email);
      multi.hmset('ptu:email:'+email, data);
      multi.exec(function(err) {
        if (err) return callback(err);
        return callback(null, data);
      });
    });
  };

  this._waitForEmail = function _waitForEmail(email, callback) {
    self.emit('message', "Awaiting " + email + " ...");
    expectSoon(
      function() {
          return (!! self.availableEmails[email]);
        },
        5000, // milliseconds,
        function(it_worked) {
          if (it_worked) {
            self.emit('message', "Received " + email);
            redis.createClient().hgetall('ptu:email:'+email, callback);
          } else {
            self.emit('error', "Timed out waiting for " + email);
            callback("Timed out waiting for " + email);
          }
        }
    );
  };

  this._getEmail = function _getEmail(serverEnv, do_verify, callback) {
    self._generateNewEmail(serverEnv, function(err, data) {
      if (err) return callback(err);
      redis.createClient().hset('ptu:email:'+data.email, 'do_verify', do_verify, function(err) {
        if (err) return callback(err);
        bid.createUser(vconf[serverEnv], data.email, data.pass, function(err) {
          if (err) {
            return callback(err);
          } else {
            return callback(null, data.email);
          }
        });
      });
    });
  };

  /*
   * _generateKeypair: get a publicKey and secretKey pair for the
   * email given in the params.  The keys are serialized and stored in
   * redis along with the rest of the email's data.
   */
  this._generateKeypair = function genKeyPair(params, callback) {
    if (!params.email) {
      return callback("params missing required email");
    }
    jwcrypto.generateKeypair({algorithm:ALGORITHM, keysize:KEYSIZE}, function(err, kp) {
      redis.createClient().hmset('ptu:email:'+params.email, {
        publicKey: kp.publicKey.serialize(),
        secretKey: kp.secretKey.serialize()
      }, function(err) {
        return callback(err, kp);
      });
    });
  };

  /*
   * getUnverifiedEmail - get a username and password, and stage it
   * with our IdP.  Don't complete the user creation; return the
   * creation url.
   */
  this.getUnverifiedEmail = function getUnverifiedEmail(serverEnv, callback) {
    this._getEmail(serverEnv, 'no', function(err, email) {
      if (err) return callback(err);
      self._waitForEmail(email, function(err, emailData) {
        if (err) {
          return callback(err);
        } else {
          return callback(null, {
            email: emailData.email,
            pass: emailData.pass,
            token: emailData.token,
            expires: emailData.expires,
            env: emailData.env,
            browserid: vconf[emailData.env].browserid,
            verifier: vconf[emailData.env].verifier
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
    this._getEmail(serverEnv, 'yes', function(err, email) {
      if (err) return callback(err);
      self._waitForEmail(email, function(err, emailData) {
        if (err) {
          return callback(err);
        } else {
          // With a verified email, we don't send back the
          // already-used verification token.
          return callback(null, {
            email: emailData.email,
            pass: emailData.pass,
            expires: emailData.expires,
            env: emailData.env,
            browserid: vconf[emailData.env].browserid,
            verifier: vconf[emailData.env].verifier
          });
        }
      });
    });
  };

  this.getUserData = function getEmailData(email, pass, callback) {
    // get the email data if the caller knows the right password
    redis.createClient().hgetall('ptu:email:'+email, function(err, data) {
      if (!data || data.pass !== pass) {
        return callback("Username and password do not match");
      }
      return callback(err, data);
    });
  };

  this.cancelAccount = function cancelAccount(email, pass, callback) {
    this.getUserData(email, pass, function(err, userData) {
      if (err) return callback(err);
      var context = JSON.parse(userData.context);
      bid.cancelAccount(userData.env, context, function(err, results) {
        return callback(err, results);
      });
    });
  };

  this.getAssertion = function getAssertion(userData, audience, callback) {
    var email = userData.email;
    var pass = userData.pass;
    var duration = userData.duration || (60 * 60 * 1000);
    var serverEnv = vconf[userData.env];
    if (! (email && pass && audience && serverEnv)) {
      return callback(new Error("required param missing"));
    }

    // Set the expiration date in unix time, not JavaScript time
    var expiresAt = unixTime() + duration;

    self._generateKeypair(userData, function(err, kp) {
      bid.authenticateUser(serverEnv, email, pass, function(err) {
        bid.certifyKey(serverEnv, email, kp.publicKey, function(err, res) {
          var cert = res.body;
          jwcrypto.assertion.sign(
            {},
            {audience: audience, expiresAt: expiresAt},
            kp.secretKey,
            function(err, assertion) {
              if (err) return self.callback(err);
              var bundle = jwcrypto.cert.bundle([cert], assertion);
              return callback(null, {
                 email: userData.email,
                 pass: userData.pass,
                 expires: userData.expires,
                 env: userData.env,
                 browserid: serverEnv.browserid,
                 verifier: serverEnv.verifier,
                 audience: audience,
                 assertion: assertion,
                 cert: cert,
                 bundle: bundle
              });
            }
          );
        });
      });
    });
  };

  this._periodicallyCullUsers();
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
            '1234567890';

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
