/**
 * bid.js - BrowserID protocol implementation
 */

const util = require('util'),
      events = require('events'),
      getRedisClient = require('./db').getRedisClient,
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
    getRedisClient()
      .multi()
      .zadd('ptu:emails:valid', expires, email)
      .zrem('ptu:emails:staging', email)
      .exec(function(err, results) {
        if (err) return callback(err);
        console.log("Email now live: " + email + "; expires: " + expires);
        return callback(null);
      });
  };

  this.completeUserCreation = function(userData, callback) {
    var err = null;
    wsapi.post(vconf[userData.env], '/wsapi/complete_user_creation', {}, {
      token: userData.token,
      pass: userData.password
    }, function(err, res) {
      if (res.code !== 200) {
        err = "Server returned " + res.code;
      }

      if (err) {
        return callback("Can't complete user creation: " + err);
      } else {
        self._stagedEmailBecomesLive(userData, callback);
      }
    });
  };

  this.startVerifyingEmails = function startVerifyingEmails() {
    var cli = getRedisClient();

    cli.blpop('ptu:mailq', 0, function(err, data) {
      // data is a tuple like [qname, data]
      try {
        data = JSON.parse(data[1]);
      } catch (err) {
        // bogus email
        console.log("bogus email data; start verifying again");
        self.startVerifyingEmails();
        return;
      }

      var email = data.email;
      var token = data.token;
      if (! (email && token)) {
        console.log("both email and token not provided: " + data);
        self.startVerifyingEmails();
        return;
      }

      // Stash the token, which is necessary to complete the bid
      // verification process, and then get all the data on this user
	  var multi = cli.multi();
      multi.hset('ptu:email:'+email, 'token', token);
      multi.hgetall('ptu:email:'+email);
      multi.exec(function(err, results) {
        if (err || results.length < 2) {
          console.log("couldn't store token and retrieve user data");
          self.startVerifyingEmails();
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
            self.startVerifyingEmails();
          });
        } else {
          self.emit('user-ready', email, token);
          self.startVerifyingEmails();
        }
      });
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
  console.log("bid.stageUser " + context.email);
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

        var cli = getRedisClient();
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
