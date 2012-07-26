/**
 * bid.js - BrowserID protocol implementation
 */

const util = require('util'),
      events = require('events'),
      redis = require('redis'),
      redisConf = require('./config'),
      vconf = require('./vconf'),
      wsapi = require('./wsapi_client');

/**
 * The Verifier sits and waits for asynchronous verification emails
 * to show up in redis, where the mail daemon will push them on
 * arrival.
 *
 * When an email arrives, the verifier checks that it matches a user
 * we are currently staging.  If it does, it sends a complete_user_creation.
 * If that returns a 200, it emits a happy signal.
 *
 * The api will catch the happy signal inside the create user sequence.
 */
var Verifier = function Verifier() {
  events.EventEmitter.call(this);
  var self = this;

  this._stagedEmailBecomesLive = function _stagedEmailBecomesLive (userData, callback) {
    var email = userData.email;
    var expires = userData.expires;
    redis.createClient().multi()
      .zadd('ptu:emails:valid', expires, email)
      .zrem('ptu:emails:staging', email)
      .exec(function(err, results) {
        if (err) return callback(err);
        console.log("Email now live: " + email + "; expires: " + expires);
        return callback(null);
      });
  };

  this.completeUserCreation = function completeUserCreation(userData, callback) {
    var err = null;
    wsapi.post(vconf[userData.env], '/wsapi/complete_user_creation', {}, {
      token: userData.token,
      pass: userData.pass
    }, function(err, res) {
      if (err) {
        return callback("Can't complete user creation: " + err);
      }

      if (res.statusCode !== 200) {
        return callback("Server returned " + res.statusCode);
      }

      self._stagedEmailBecomesLive(userData, callback);
    });
  };

  /*
   * Keep an eye on the ptu:expired queue for emails that have been
   * culled from the db.  To be nice, we delete these from the
   * provider.
   */
  this._startCancelingExpiredEmails = function _startCancelingExpiredEmails() {
    redis.createClient().blpop('ptu:expired', 0, function(err, data) {
      // data is a tuple like [qname, data]
      // where data contains a context of an expired account
      console.log("blpopped from ptu:expired: " + data);
      try {
        data = JSON.parse(data[1]);
        var email = data[0];
        var env = data[1];
        cancelAccount(email, env, function(err) {
          if (err) console.log("ERROR: cancelAccount returned: " + err);
        });
      } catch (err) {
        // XXX should flush from redis anyway?
        console.log("ERROR: _startCancelingExpiredEmails: " + err);
      }

      // Don't flood the server with account deletions.  No more than
      // one per second.
      setTimeout(self._startCancelingExpiredEmails, 1000);
    });
  };

  this._startVerifyingEmails = function _startVerifyingEmails() {
    redis.createClient().blpop('ptu:mailq', 0, function(err, data) {
      // data is a tuple like [qname, data]
      try {
        data = JSON.parse(data[1]);
      } catch (err) {
        // bogus email
        console.log("bogus email data; start verifying again");
        self._startVerifyingEmails();
        return;
      }

      var email = data.email;
      var token = data.token;
      if (! (email && token)) {
        console.log("_startVerifyingEmails: require both email and token");
        self._startVerifyingEmails();
        return;
      }

      // Stash the token, which is necessary to complete the bid
      // verification process, and then get all the data on this user
	  var multi = redis.createClient().multi();
      multi.hset('ptu:email:'+email, 'token', token);
      multi.hgetall('ptu:email:'+email);
      multi.exec(function(err, results) {
        if (err || results.length < 2) {
          console.log("couldn't store token and retrieve user data");
          self._startVerifyingEmails();
          return;
        }
        var userData = results[1];

        // maybe complete user creation
        if (userData.do_verify === 'yes') {
          self.completeUserCreation(userData, function(err) {
            if (err) {
              self.emit('error', err);
            } else {
              self.emit('user-ready', email, null);
            }
            self._startVerifyingEmails();
          });
        } else {
          self.emit('user-ready', email, token);
          self._startVerifyingEmails();
        }
      });
    });
  };

  this._startCancelingExpiredEmails();
  this._startVerifyingEmails();
  return this;
};

util.inherits(Verifier, events.EventEmitter);

var getSessionContext = function getSessionContext(config, context, callback) {
  // Get a session_context
  // Modify @context in place with results

  wsapi.get(config, '/wsapi/session_context', context, {
  }, function(err, res) {
    if (err) {
      console.log("ERROR: getSessionContext: " + err);
      return callback(err);
    }

    if (res.statusCode !== 200) {
      console.log("ERROR: getSessionContext: server status: " + res.statusCode);
      return callback(new Error("Can't get session context: server status " + res.statusCode));
    }

    // body of the response is a JSON string like
    //
    // {"csrf_token":"TVEdXvrgYfRG7k004jFmQQ==",
    //  "server_time":1337820896110,
    //  "authenticated":false,
    //  "domain_key_creation_time":1322071714847,
    //  "random_seed":"K3nFtBMsZwG0J0pfC+U3qxHSl3x21tD6QhKYd1si/0U=",
    //  "data_sample_rate":0}
    //
    //  Store this in the context object.  Note that the token is called
    //  csrf_token, not csrf

    var session = JSON.parse(res.body);
    if (!context.session) {
      context.session = {};
    }
    for (var key in session) {
      context.session[key] = session[key];
    }

    return callback(null, res);
  });
};

var _getAddressInfo = function _getAddressInfo(config, context, callback) {
  // I don't know if we care about the address info ...
  // Modify @context in place

  wsapi.get(config, '/wsapi/address_info', context, {
    email: context.email
  }, function(err, res) {
    if (err) {
      console.log("ERROR: _getAddressInfo: " + err);
      return callback(err);
    }
    if (res.statusCode !== 200) {
      return callback(new Error("Can't get address info: server status " + res.statusCode));
    }

    context.address_info = JSON.parse(res.body);

    return callback(null, res);
  });
};

var authenticateUser = function authenticateUser(config, email, pass, callback) {
  redis.createClient().hget('ptu:email:'+email, 'context', function(err, data) {
    var context = JSON.parse(data);
    console.log("bid.authenticate user " + context.email);
    wsapi.post(config, '/wsapi/authenticate_user', context, {
      email: email,
      pass: pass,
      ephemeral: true
    }, function(err, res) {
      if (res.statusCode !== 200) {
        return callback("ERROR: authenticateUser: server returned " + res.statusCode);
      }

      var body = JSON.parse(res.body);
      if (body.success !== true) {
        return callback("Authentication failed");
      } else {
        // Save our updated tokens
        var set_cookie = res.headers['set-cookie'][0].split("=");
        var cookieJar = {};
        var key = 'ptu:email:'+context.email;
        cookieJar[set_cookie[0]] = set_cookie[1];
        context.cookieJar = cookieJar;
        var multi = redis.createClient().multi();
        multi.hset(key, 'userid', body.userid);
        multi.hset(key, 'context', JSON.stringify(context));
        multi.exec(function(err, result) {
          return callback(err);
        });
      }
    });
  });
};

var stageUser = function stageUser(config, context, callback) {
  console.log("bid.stageUser " + context.email);
  wsapi.post(config, '/wsapi/stage_user', context, {
    csrf: context.session.csrf_token,
    email: context.email,
    pass: context.pass,
    site: context.site
  }, function(err, res) {
    if (err) return callback(err);

    if (!res) {
      return callback("ERROR: stageUser: wsapi.post did not return a response");
    }

    if (res.statusCode !== 200) {
      console.log("ERROR: stageUser: err=" + err + ", server code=" + res.statusCode);
    }

    if (res.statusCode === 429) {
      // too many requests!
      return callback(new Error("Can't stage user: we're flooding the server"));
    }

    if (res.statusCode !== 200) {
      return callback(new Error("Can't stage user: server status " + res.statusCode));
    }

    return callback(null);
  });
};

var createUser = function createUser(config, email, pass, callback) {
  console.log("bid.createUser email: " + email);
  var context = {
    email: email,
    pass: pass,
    site: process.env.PUBLIC_URL || 'http://personatestuser.org',
    keys: {}
  };

  getSessionContext(config, context, function(err) {
    if (err) return callback(err);

    _getAddressInfo(config, context, function(err) {
      if (err) return callback(err);

      stageUser(config, context, function(err) {
        if (err) return callback(err);

        // Store the session for this email, so we can
        // continue our conversation with the server later
        // to get a cert.

        redis.createClient().hset('ptu:email:'+email, 'context', JSON.stringify(context), function(err) {
          // Now we wait for an email to return from browserid.
          // The email will be received by bin/email, which will
          // push the email address and token pair into a redis
          // queue.
          return callback(err);
        });
      });
    });
  });
};

var certifyKey = function certifyKey(config, email, pubkey, callback) {
  redis.createClient().hgetall('ptu:email:'+email, function(err, data) {
    if (err) return callback(err);
    try {
      var context = JSON.parse(data.context);
    } catch (x) {
      return callback("Bad context field for " + email + ": " +err);
    }
    wsapi.post(config, '/wsapi/cert_key', context, {
      email: email,
      pubkey: pubkey.serialize(),
      ephemeral: false
    }, function(err, res) {
      if (err) {
        console.log("ERROR: certifyKey: " + err);
        return callback(err);
      }
      return callback(null, res);
    });
  });
};

var cancelAccount = function cancelAccount(context, callback) {
  // Authenticate with the context and then cancel the account

  // Either way, remove the user from the redis db.
  if (context.email) {
    redis.createClient().multi()
      .del('ptu:email:'+context.email)
      .zrem('ptu:emails:staging', context.email)
      .zrem('ptu:emails:valid', context.email)
      .exec();
  }
  if (Object.keys(vconf).indexOf(context.env) === -1) {
    // if env is not prod, dev, or stage, then default to prod
    context.env = 'prod';
  }

  wsapi.post(vconf[context.env], '/wsapi/authenticate_user', context, {
    email: context.email,
    pass: context.pass,
    ephemeral: true
  }, function(err, res) {
    if (err || res.statusCode !== 200) {
      return callback("ERROR: cancelAccount: authenticateUser: server code " + res.statusCode);
    }

    // Get the new authentication cookie and save it in our context
    var body = JSON.parse(res.body);

    if (!body.success || !res.headers['set-cookie']) {
      // maybe user doesn't exist etc.
      return callback("User not found");
    }

    var set_cookie = res.headers['set-cookie'][0].split("=");
    var cookieJar = {};
    cookieJar[set_cookie[0]] = set_cookie[1];
    context.cookieJar = cookieJar;

    // Now cancel the account
    wsapi.post(vconf[context.env], '/wsapi/account_cancel', context, {
      email: context.email,
      pass: context.pass
    }, function(err, res) {
      if (err) {
        return callback("ERROR: cancelAccount: " + err);
      }
      if (res.statusCode !== 200) {
        return callback("ERROR: cancelAccount: server returned status " + res.statusCode);
      }
      return callback(null);
    });
  });
};



// the individual api calls
module.exports.getSessionContext = getSessionContext;
module.exports.stageUser = stageUser;
module.exports.authenticateUser = authenticateUser;
module.exports.certifyKey = certifyKey;
module.exports.cancelAccount = cancelAccount;

// higher-level compositions
module.exports.createUser = createUser;
module.exports.Verifier = Verifier;
