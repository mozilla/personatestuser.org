/**
 * bid.js - BrowserID protocol implementation
 */

const util = require('util'),
      events = require('events'),
      redis = require('./redis'),
      redisConf = require('./config'),
      wsapi = require('./wsapi_client'),
      logEvent = require('./events').logEvent;

function request(type, config, url, context, data, callback) {
  logEvent(type.toUpperCase() + ' ' + url, context.email);

  wsapi[type](config, url, context, data, function(err, res) {
    if (err) {
      logEvent(err.toString(), context.email);
      return callback(err);
    }

    if (!res) {
      return callback(new Error(url + " did not return a response"));
    }

    logEvent(url + " returned " + res.statusCode, context.email);

    if (res.statusCode === 429) {
      // too many requests!
      return callback(new Error(url + " returned 429; you are flooding the server"));
    }
    else if (res.statusCode !== 200) {
      console.log(url,
          "\nconfig=", JSON.stringify(config, null, 2),
          "\ncontext=", JSON.stringify(context, null, 2),
          "\ndata=", JSON.stringify(data, null, 2),
          "\nres.statusCode=", res.statusCode,
          "\nres.body=", JSON.stringify(res.body, null, 2));

      return callback(new Error(url + " returned status " + res.statusCode));
    }

    callback(null, res);
  });
}

function post(config, url, context, data, callback) {
  request('post', config, url, context, data, callback);
}

function get(config, url, context, data, callback) {
  request('get', config, url, context, data, callback);
}

/**
 * The EmailVerifier sits and waits for asynchronous verification emails
 * to show up in redis, where the mail daemon will push them on
 * arrival.
 *
 * When an email arrives, the verifier checks that it matches a user
 * we are currently staging.  If it does, it sends a complete_user_creation.
 * If that returns a 200, it emits a happy signal.
 *
 * The api will catch the happy signal inside the create user sequence.
 */
var EmailVerifier = function EmailVerifier() {
  events.EventEmitter.call(this);
  var self = this;

  this._stagedEmailBecomesLive = function _stagedEmailBecomesLive (userData, callback) {
    var email = userData.email;
    var expires = userData.expires;
    var client = redis.createClient();
    client.multi()
      .zadd('ptu:emails:valid', expires, email)
      .zrem('ptu:emails:staging', email)
      .exec(function(err, results) {
        client.quit();
        if (err) return callback(err);
        console.log("Email now live: " + email + "; expires: " + expires);
        return callback(null);
      });
  };

  this.completeUserCreation = function completeUserCreation(userData, callback) {
    var err = null;
    var config = {
      browserid: userData.browserid,
      verifier: userData.verifier
    };
    post(config, '/wsapi/complete_user_creation', userData, {
      token: userData.token,
      pass: userData.pass
    }, function(err, res) {
      if (err) return callback(err);

      self._stagedEmailBecomesLive(userData, callback);
    });
  };

  /*
   * Keep an eye on the ptu:expired queue for emails that have been
   * culled from the db.  To be nice, we delete these from the
   * provider.
   */
  this._startCancelingExpiredEmails = function _startCancelingExpiredEmails() {
    var client = redis.createClient();
    client.blpop('ptu:expired', 0, function(err, data) {
      client.quit();
      // data is a tuple like [qname, context]
      try {
        var context = JSON.parse(data[1]);
        cancelAccount(context, function(err) {
          if (err) console.log("ERROR: cancelAccount("+context.email+") returned: " + err);
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
    var client = redis.createClient();
    client.blpop('ptu:mailq', 0, function(err, data) {
      client.quit();
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
      var headers = data.headers;
      var token = data.token;
      if (! (email && token)) {
        console.log("_startVerifyingEmails: require both email and token");
        self._startVerifyingEmails();
        return;
      }

      // Stash the token, which is necessary to complete the bid
      // verification process, and then get all the data on this user
      client = redis.createClient();
      client.multi()
        .hmset('ptu:email:'+email, 'token', token, 'headers', JSON.stringify(headers))
        .hgetall('ptu:email:'+email)
        .exec(function(err, results) {
          client.quit();
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
                self.emit('user-ready', email, userData);
              }
              self._startVerifyingEmails();
            });
          } else {
            self.emit('user-ready', email, userData);
            self._startVerifyingEmails();
          }
        });
    });
  };

  this._startCancelingExpiredEmails();
  this._startVerifyingEmails();
  return this;
};

util.inherits(EmailVerifier, events.EventEmitter);

var getSessionContext = function getSessionContext(config, context, callback) {
  // Get a session_context
  // Modify @context in place with results
  get(config, '/wsapi/session_context', context, {}, function(err, res) {
    if (err) return callback(err);

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
  get(config, '/wsapi/address_info', context, {
    email: context.email
  }, function(err, res) {
    if (err) return callback(err);

    context.address_info = JSON.parse(res.body);

    return callback(null, res);
  });
};

var authenticateUser = function authenticateUser(config, email, pass, callback) {
  var client = redis.createClient();
  client.hget('ptu:email:'+email, 'context', function(err, data) {
    client.quit();
    var context = JSON.parse(data);

    post(config, '/wsapi/authenticate_user', context, {
      email: email,
      pass: pass,
      ephemeral: true
    }, function(err, res) {
      if (err) return callback(err);

      var body = JSON.parse(res.body);
      if (body.success !== true) {
        logEvent("Authentication failed", email);
        return callback(new Error("Authentication failed"));
      } else {
        // Save our updated tokens
        var set_cookie = res.headers['set-cookie'][0].split("=");
        var cookieJar = {};
        var key = 'ptu:email:'+context.email;
        cookieJar[set_cookie[0]] = set_cookie[1];
        context.cookieJar = cookieJar;
        client = redis.createClient();
        client.multi()
          .hset(key, 'userid', body.userid)
          .hset(key, 'context', JSON.stringify(context))
          .exec(function(err, result) {
            client.quit();
            return callback(err);
          });
      }
    });
  });
};

var stageUser = function stageUser(config, context, callback) {
  post(config, '/wsapi/stage_user', context, {
    email: context.email,
    pass: context.pass,
    site: context.site
  }, function(err, res) {
    if (err) return callback(err);

    return callback(null);
  });
};

var createUser = function createUser(config, email, pass, callback) {
  var context = {
    email: email,
    pass: pass,
    site: process.env.PUBLIC_URL || 'http://personatestuser.org',
    keys: {}
  };

  logEvent("Create user", context.email);

  /*_getAddressInfo(config, context, function(err) {*/
    /*if (err) return callback(err);*/

    stageUser(config, context, function(err) {
      if (err) return callback(err);

      console.log("user staged");

      // Store the session for this email, so we can
      // continue our conversation with the server later
      // to get a cert.

      var client = redis.createClient();
      client.hset('ptu:email:'+email, 'context', JSON.stringify(context), function(err) {
        client.quit();
        // Now we wait for an email to return from browserid.
        // The email will be received by bin/email, which will
        // push the email address and token pair into a redis
        // queue.
        return callback(err);
      });
    });
  /*});*/
};

var certifyKey = function certifyKey(config, email, pubkey, callback) {
  var context = {};

  logEvent("Certify key", email.email);

  var client = redis.createClient();
  client.hgetall('ptu:email:'+email, function(err, data) {
    client.quit();
    if (err) return callback(err);
    try {
      context = JSON.parse(data.context);
    } catch (err) {
      return callback(err);
    }

    post(config, '/wsapi/cert_key', context, {
      email: email,
      pubkey: pubkey.serialize(),
      ephemeral: false
    }, function(err, res) {
      if (err) return callback(err);

      return callback(null, res);
    });
  });
};

var cancelAccount = function cancelAccount(context, callback) {
  // Authenticate with the context and then cancel the account

  // Either way, remove the user from the redis db.
  if (context.email) {
    var client = redis.createClient();
    client.multi()
      .del('ptu:email:'+context.email)
      .del('ptu:events:'+context.email)
      .zrem('ptu:emails:staging', context.email)
      .zrem('ptu:emails:valid', context.email)
      .exec(function(err, result) {
        client.quit();
      });
  }

  var config = {
    browserid: context.browserid,
    verifier: context.verifier
  };
  post(config, '/wsapi/authenticate_user', context, {
    email: context.email,
    pass: context.pass,
    ephemeral: true
  }, function(err, res) {
    if (err) return callback(err);

    // Get the new authentication cookie and save it in our context
    var body = JSON.parse(res.body);

    if (!body.success || !res.headers['set-cookie']) {
      // maybe user doesn't exist etc.
      return callback(new Error("authenticate_user failed.  User may not exist?"));
    }

    var set_cookie = res.headers['set-cookie'][0].split("=");
    var cookieJar = {};
    cookieJar[set_cookie[0]] = set_cookie[1];
    context.cookieJar = cookieJar;

    // Now cancel the account
    post(config, '/wsapi/account_cancel', context, {
      email: context.email,
      pass: context.pass
    }, function(err, res) {
      if (err) return callback(err);

      console.log("Account canceled: " + context.email);
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
module.exports.EmailVerifier = EmailVerifier;
