const jwcrypto = require('jwcrypto'),
      fs = require('fs'),
      util = require('util'),
      url = require('url'),
      events = require('events'),
      path = require('path'),
      bid = require('./bid'),
      unixTime = require('./time').unixTime,
      redis = require('./redis'),
      logEvent = require('./events').logEvent,
      ALGORITHM = "RS",
      KEYSIZE = 256,
      EMAIL_TIMEOUT = 60 * 1000,
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
  //                      env       server env (prod, dev, stage, local, custom)
  //                      browserid browserid url
  //                      verifier  verifier url
  //                      do_verify flag
  // ptu:events:<email> = zset of events pertaining to an email address
  //
  // Emails start their life in staging and, if all goes well, end
  // up in ptu:emails once validated etc.  We cull both zsets
  // regularly for expired data.

  this._cullOldEmails = function _cullOldEmails(age, callback) {
    var toCull = {};
    var email;

    // asynchronously cull the outdated emails in valid and staging
    var client = redis.createClient();
    client.zrangebyscore('ptu:emails:valid', '-inf', age, function(err, results) {
      client.quit();
      if (err) {
        console.log("ERROR: _cullOldEmails, looking for valid emails:", err);
        return callback(err);
      }
      results.forEach(function(email) {
        toCull[email] = true;
      });

      client = redis.createClient();
      client.zrangebyscore('ptu:emails:staging', '-inf', age, function(err, results) {
        client.quit();
        if (err) {
          console.log("ERROR: _cullOldEmails, looking for staging emails:", err);
          return callback(err);
        }
        results.forEach(function(email) {
          toCull[email] = true;
        });

        // Maybe nothing to delete
        if (!Object.keys(toCull).length) {
          return (null);
        }

        // we need to get the env for each email so we know how to
        // delete the account
        client = redis.createClient();
        var multi = client.multi();
        Object.keys(toCull).forEach(function(email) {
          console.log("Will cull expired email: " + email);
          multi.hmget('ptu:email:'+email, 'email', 'pass', 'browserid');
        });
        multi.exec(function(err, tuples) {
          client.quit();
          if (err) {
            console.log("ERROR: redis multi:", err);
            return callback(err);
          }
          client = redis.createClient();
          multi = client.multi();
          tuples.forEach(function(tuple) {
            // Push the email to be culled and its domain onto the expired queue.
            // The bid module will take it from there and tell the IdP to delete
            // the account.

            // Each context is a list, not a dictionary.
            var context = {
              email: tuple[0],
              pass: tuple[1],
              browserid: tuple[2]
            };

            // The data will actually be delete by bid.cancelAccount
            // Which indicates that these functions belong back in the bid module ...
            multi.rpush('ptu:expired', JSON.stringify(context));
          });
          multi.exec(function(err, result) {
            client.quit();
            callback(err, result);
          });
        });
      });
    });
  ;}

  this._periodicallyCullUsers = function _periodicallyCullUsers(interval) {
    // by default, cull every minute
    var interval_ms = (interval || ONE_MIN_IN_SECONDS) * 1000;

    // make sure this only gets called once
    if (this._alreadyCulling === true) return;
    this._alreadyCulling = true;

    setInterval(function cullUsers() {
      var one_hour_ago = unixTime() - ONE_HOUR_IN_SECONDS;

      self._cullOldEmails(one_hour_ago, function(err, n) {
        if (err) console.log("ERROR: _cullOldEmails returned: " + err.toString());
      });
    }, interval_ms);
  };


  // The emailVerifier waits for emails to arrive from the IdP asking the
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
  this.emailVerifier = new bid.EmailVerifier();
  this.emailCallbacks = {};
  this.emailVerifier.on('error', function(err) {
    console.log("EmailVerifier ERROR: " + err);
  });

  // When an email is ready, fire the callback that's waiting for it, and
  // remove the callback.
  this.emailVerifier.on('user-ready', function(email, data) {
    var callback = self.emailCallbacks[email];
    if (typeof callback === 'function') {
      var msg = "Received return email " + email;
      /*logEvent(msg, email);*/
      self.emit('message', "Received " + email);

      // Call back with the user data, which at this point should
      // be exactly what's stored in ptu:email:<email>
      callback(null, data);
      delete self.emailCallbacks[email];
    }
  });

  // XXX i would like to have a select(db, onready), but i'm getting
  // mysterious crashes from hiredis claiming that an error isn't
  // being handled (despite the above 'on error' handler)
  onready(null);

  this._stageEmail = function _stageEmail(params, callback) {
    if (! (params.email && params.pass && params.browserid && params.verifier && params.expires)) {
      return callback("Missing required params for stageEmail");
    }
    var client = redis.createClient();
    client.multi()
      .zadd('ptu:emails:staging', params.expires, params.email)
      .hmset('ptu:email:'+params.email, params)
      .exec(function(err) {
        client.quit();
        if (err) {
          return callback(err);
        }
        return callback(null, params);
      });
  };

  /**
   * Create or re-use an existing email with the given params.
   *
   * @param params
   *        (dict)      Must contain the fields:
   *                    name       username for email
   *                    pass       password
   *                    env        prod, stage, dev, local, custom
   *                    browserid  browserid server to use (if custom)
   *                    verfier    verifier server to use (if custom)
   *
   * @param callback
   *        (function)  Callback to invoke when finished
   *
   * If the account does not exist, create it and set the password;
   * stage it, and callback with account details.
   *
   * If the email account already exists, and params contains the
   * correct password, bump the expiration date and callback with
   * account details.
   *
   * If the account exists and the caller does not know the correct
   * password, callback with error.
   *
   */
  this._createNewEmail = function _createNewEmail(params, callback) {
    var email = (params.email || "").trim();
    var pass = (params.pass || "").trim();
    var env = params.env;
    var browserid = (params.browserid || "").trim();
    var verifier = (params.verifier || "").trim();

    if (! (email && pass && browserid && verifier)) {
      return callback(new Error("Missing required params for _createNewEmail"));
    }

    // sanity check that this email is ok for our domain
    var validEmailRE = new RegExp('^[\\w\\d_-]+@' + DEFAULT_DOMAIN + '$');
    if (! validEmailRE.test(email)) {
      return callback(new Error("Email address invalid for " + DEFAULT_DOMAIN + ".  Got: " + email));
    }

    // Check whether this email exists already
    var client = redis.createClient();
    client.hgetall('ptu:email:'+email, function(err, data) {
      client.quit();
      if (err) {
        console.log("ERROR: _createNewEmail: redis hgetall:", err);
        return callback(err);
      }

      // If the email does exist, and the caller knows the right password,
      // bump the expiration time and return the valid account data.
      else if (data && data.pass === pass) {
        /*logEvent("Re-use existing email account", email);*/
        var expires = unixTime() + ONE_HOUR_IN_SECONDS;
        client = redis.createClient();
        client.hset('ptu:email:'+email, 'expires', expires, function(err) {
          client.quit();
          if (err) {
            console.log("ERROR: _createNewEmail: redis hset:", err);
            return callback(err);
          }
          data.expires = expires;
          return callback(null, data);
        });
      }

      // Email exists, but caller doesn't know password.  Error.
      else if (data && data.pass !== pass) {
        return callback(new Error("Password and username mismatch for " + email));
      }

      // Email does not exist.  Create it.
      else {
        /*logEvent("Create new email account", email);*/
        var params = {
          email: email,
          pass: pass,
          expires: unixTime() + ONE_HOUR_IN_SECONDS,
          env: env,
          browserid: browserid,
          verifier: verifier
        };
        return self._stageEmail(params, callback);
      }
    });
  };

  /**
   * Create and stage a new email account.
   *
   * @param params
   *        (dict)      Required field:
   *                    env        Description of the browserid server env to use
   *                    browserid  browserid server to use
   *                    verfier    verifier server to use
   *
   * @param callback
   *        (function)  Callback to invoke when finished
   *
   */
  this._generateNewEmail = function _generateNewEmail(params, callback) {
    var name = getRandomName();
    var pass = getRandomPassword();
    // we will assign the exact email below
    var email;

    if (!params.browserid) return callback(new Error("browserid url param required for custom env"));
    if (!params.verifier) return callback(new Error("verifier url param required for custom env"));

    var client = redis.createClient();
    client.incr('ptu:nextval', function(err, val) {
      client.quit();
      if (err) {
        console.log("ERROR: _generateNewEmail: redis:", err);
        return callback(err);
      }
      email = name + val + '@' + DEFAULT_DOMAIN;
      /*logEvent("Generate new email account", email);*/
      var data = {
        email: email,
        pass: pass,
        expires: unixTime() + ONE_HOUR_IN_SECONDS,
        env: params.env,
        browserid: params.browserid,
        verifier: params.verifier
      };
      self._stageEmail(data, callback);
    });
  };

  /**
   * Check that the email has eventually been verified.
   *
   * @param email
   *        (string)    The email address to expect
   *
   * @param callback
   *        (function)  Function to invoke on completion
   *
   * If the email hasn't arrived within 10 seconds, callback
   * with an error and remove the callback from the dictionary
   * of waiting callbacks.
   */
  this._waitForEmail = function _waitForEmail(email, callback) {
    // stash the callback in the emailCallbacks table.
    this.emailCallbacks[email] = callback;
    // If it's still there in 10 seconds, then the verifier did
    // not hear a user-ready event for this email, and we error.
    setTimeout(function() {
      var still_there = self.emailCallbacks[email];
      if (typeof still_there === 'function') {
        var err = "Timed out after " + EMAIL_TIMEOUT + "ms awaiting return of email " + email;
        /*logEvent(err, email);*/
        self.emit('error', err);
        callback(err);
        delete(self.emailCallbacks[email]);
      }
      // if no callback was found, great!  Everything went
      // according to plan and we just leave it at that.
    }, EMAIL_TIMEOUT);
  };

  this._getEmail = function _getEmail(params, do_verify, callback) {
    var getEmailFunc;
    if (params.email && params.pass) {
      getEmailFunc = self._createNewEmail;
    } else {
      getEmailFunc = self._generateNewEmail;
    }

    getEmailFunc(params, function(err, data) {
      if (err) return callback(err);
      var client = redis.createClient();
      client.hset('ptu:email:'+data.email, 'do_verify', do_verify, function(err) {
        client.quit();
        if (err) return callback(err);
        bid.createUser(params, data.email, data.pass, function(err) {
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
    /*logEvent("Generate keypair", params.email);*/
    if (!params.email) {
      return callback(new Error("params missing required email"));
    }
    jwcrypto.generateKeypair({algorithm:ALGORITHM, keysize:KEYSIZE}, function(err, kp) {
      /*logEvent("Keypair generated", params.email);*/
      var client = redis.createClient();
      client.hmset('ptu:email:'+params.email, {
        publicKey: kp.publicKey.serialize(),
        secretKey: kp.secretKey.serialize()
      }, function(err) {
        client.quit();
        return callback(err, kp);
      });
    });
  };

  /*
   * getUnverifiedEmail - get a username and password, and stage it
   * with our IdP.  Don't complete the user creation; return the
   * creation url.
   */
  this.getUnverifiedEmail = function getUnverifiedEmail(params, callback) {
    self._getEmail(params, 'no', function(err, email) {
      if (err) {
        console.log("ERROR: getUnverifiedEmail: _getEmail returned", err.toString());
        return callback(err);
      }
      self._waitForEmail(email, function(err, emailData) {
        if (err) {
          console.log("ERROR: getUnverifiedEmail: _waitForEmail returned", err.toString());
          return callback(err);
        } else {
          return callback(null, {
            email: emailData.email,
            pass: emailData.pass,
            token: emailData.token,
            headers: JSON.parse(emailData.headers),
            expires: emailData.expires,
            context: JSON.parse(emailData.context),
            env: emailData.env,
            browserid: emailData.browserid,
            verifier: emailData.verifier
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
  this.getVerifiedEmail = function getVerifiedEmail(params, callback) {
    self._getEmail(params, 'yes', function(err, email) {
      if (err) {
        console.log("ERROR: getVerifiedEmail: _getEmail returned:", err.toString());
        return callback(err);
      }
      self._waitForEmail(email, function(err, emailData) {
        if (err) {
          console.log("ERROR: getVerifiedEmail: _waitForEmail returned:", err.toString());
          return callback(err);
        } else {
          // With a verified email, we don't send back the
          // already-used verification token.
          return callback(null, {
            email: emailData.email,
            pass: emailData.pass,
            headers: JSON.parse(emailData.headers),
            expires: emailData.expires,
            context: JSON.parse(emailData.context),
            env: emailData.env,
            browserid: emailData.browserid,
            verifier: emailData.verifier
          });
        }
      });
    });
  };

  this.getUserData = function getEmailData(email, pass, callback) {
    // get the email data if the caller knows the right password
    var client = redis.createClient();
    client.hgetall('ptu:email:'+email, function(err, data) {
      client.quit();
      if (err) {
        console.log("ERROR: getUserData: redis hgetall:", err);
        return callback(err);
      }

      if (!data) {
        return callback(null, null);
      }

      if (data.pass !== pass) {
        return callback(new Error("Username and password do not match"));
      }

      return callback(err, data);
    });
  };

  this.cancelAccount = function cancelAccount(email, pass, callback) {
    this.getUserData(email, pass, function(err, userData) {
      if (err) {
        console.log("ERROR: cancelAccount: getUserData returned:", err.toString());
        return callback(err);
      }
      bid.cancelAccount(userData, function(err, results) {
        if (err) console.log("ERROR: cancelAccount: bit.cancelAccount returned:", err.toString());
        return callback(err, results);
      });
    });
  };

  this.getAssertion = function getAssertion(userData, audience, callback) {
    /*logEvent("Get assertion", userData.email);*/

    var email = userData.email;
    var pass = userData.pass;
    var duration = userData.duration || (60 * 60 * 1000);
    var serverEnv = {
      browserid: userData.browserid,
      verifier: userData.verifier
    };

    if (! (email && pass && audience && serverEnv.browserid && serverEnv.verifier)) {
      return callback(new Error("required param missing"));
    }

    // Set the expiration date in unix time, not JavaScript time
    var expiresAt = unixTime() * 1000 + duration;

    self._generateKeypair(userData, function(err, kp) {
      if (err) {
        console.log("ERROR: getAssertion: in _generateKeypair:", err);
        return callback(err);
      }
      bid.authenticateUser(serverEnv, email, pass, function(err) {
        if (err) {
          console.log("ERROR: getAssertion: bid.authenticateUser returned:", err.toString());
          return callback(err);
        }
        bid.certifyKey(serverEnv, email, kp.publicKey, function(err, res) {
          if (err) {
            console.log("ERROR: getAssertion: bid.certifyKey returned:", err.toString());
            return callback(err);
          }
          var cert = res.body;
          jwcrypto.assertion.sign(
            {},
            {audience: audience, expiresAt: expiresAt},
            kp.secretKey,
            function(err, assertion) {
              if (err) {
                /*logEvent(err.toString(), userData.email);*/
                return self.callback(err);
              }
              var bundle = jwcrypto.cert.bundle([cert], assertion);
              return callback(null, {
                 email: userData.email,
                 pass: userData.pass,
                 headers: JSON.parse(userData.headers),
                 expires: userData.expires,
                 context: JSON.parse(userData.context),
                 env: userData.env,
                 browserid: serverEnv.browserid,
                 verifier: serverEnv.verifier,
                 audience: audience,
                 assertion: bundle
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
