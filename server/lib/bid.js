/**
 * bid.js - BrowserID protocol implementation
 */

const util = require('util'),
      events = require('events'),
      redis = require('redis'),
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

  this._stagedEmailBecomesLive = function _stagedEmailBecomesLive (email, expires, callback) {
    redis.createClient()
      .multi()
      .zadd('ptu:emails:valid', expires, email)
      .zrem('ptu:emails:staging', email)
      .exec(function(err, results) {
        if (err) return callback(err);
        console.log("Email now live: " + email + "; expires: " + expires);
        return callback(null);
      });
  };

  this.startVerifyingEmails = function startVerifyingEmails() {
    redis.createClient().blpop('ptu:mailq', 0, function(err, data) {
      // data is a tuple like [qname, data]
      try {
        data = JSON.parse(data[1]);
      } catch (err) {
        // bogus email
        self.startVerifyingEmails();
        return;
      }

      var email = data.email;
      var token = data.token;
      if (email && token) {
        // Get the user's password.  This will verify that
        // we are staging this user
        redisClient.hgetall("ptu:email:"+email, function(err, data) {
          var pass = data.password;
          var serverEnv = data.env;
          if (!err && pass && serverEnv) {
            // Complete the user creation with browserid
            wsapi.post(vconf[serverEnv], '/wsapi/complete_user_creation', {}, {
              token: token,
              pass: pass
            }, function(err, res) {
              if (res.code !== 200) {
                err = new Error("Server returned " + res.code);
              }
              if (err) {
                self.emit('error', "Can't complete user creation: " + err);
              } else {
                // The smell of success.
                //
                // No errors.  Whew!  If we are here, we have retrieved a
                // user email and token from the mail queue, fetched the
                // corresponding password, and successfully completed the
                // creation of that user with browserid.
                self._stagedEmailBecomesLive(email, data.expires, function(err) {
                  if (err) {
                    self.emit('error', err);
                  } else {
                    self.emit('user-created', email);
                  }
                });
              }
              self.startVerifyingEmails();
            });
          } else {
            // no password - user staging may have timed out
            console.log("Received a verification email for a user we're not staging");
            self.startVerifyingEmails();
          }
        });
      } else {
        console.log("Got some weird data from the q: " + JSON.stringify(data));
        self.startVerifyingEmails();
      }
    });
  };

  return this;
};

util.inherits(Verifier, events.EventEmitter);

var getSessionContext = function getSessionContext(config, context, callback) {
  // Get a session_context
  // Modify @context in place with results

  wsapi.get(config, '/wsapi/session_context', context, {
  }, function(err, res) {
    if (err) return callback(err);

    if (res.code !== 200) {
      return callback(new Error("Can't get session context: server status " + res.code));
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
    for (var key in session) {
      context[key] = session[key];
    }
    console.log("context updated with session_context response");

    return callback(null, res);
  });
};

var getAddressInfo = function getAddressInfo(config, context, callback) {
  // I don't know if we care about the address info ...
  // Modify @context in place

  wsapi.get(config, '/wsapi/address_info', context, {
    email: context.email
  }, function(err, res) {
    if (err) return callback(err);

    if (res.code !== 200) {
      return callback(new Error("Can't get address info: server status " + res.code));
    }

    context.address_info = JSON.parse(res.body);

    return callback(null, res);
  });
};

var stageUser = function stageUser(config, context, callback) {
  console.log("bid.stageUser config: " + JSON.stringify(config, null, 2));
  console.log("bid.stageUser context: " + JSON.stringify(context, null, 2));
  wsapi.post(config, '/wsapi/stage_user', context, {
    csrf: context.csrf_token,
    email: context.email,
    pass: context.pass,
    site: context.site
  }, function(err, res) {
    if (err || res.code !== 200) {
      console.log("stageUser: err=" + err + ", code=" + res.code);
    }
    if (err) return callback(err);

    if (res.code === 429) {
      // too many requests!
      return callback(new Error("Can't stage user: we're flooding the server"));
    }

    if (res.code !== 200) {
      return callback(new Error("Can't stage user: server status " + res.code));
    }


    /*
      Thanks for verifying your email address. This message is being sent to
    you to complete your sign-in to http://localhost.

      Finish registration by clicking this link:
    https://diresworb.org/verify_email_address?token=7B4fNtCXd2zgDeJRRHp8ClZSMDxxr8FJPO17UGRlf5dozozp

      If you are NOT trying to sign into this site, just ignore this email.

      Thanks,
      BrowserID
      (A better way to sign in)
      */
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

    getAddressInfo(config, context, function(err) {
      if (err) return callback(err);

      stageUser(config, context, function(err) {
        if (err) return callback(err);

	    // Store the session for this email, so we can
        // continue our conversation with the server later
        // to get a cert.

        var cli = redis.createClient();
        cli.hset('ptu:email:'+email, 'session', JSON.stringify(context), function(err) {
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

// the individual api calls
module.exports.getSessionContext = getSessionContext;
module.exports.getAddressInfo = getAddressInfo;
module.exports.stageUser = stageUser;

// higher-level compositions
module.exports.createUser = createUser;
module.exports.Verifier = Verifier;
