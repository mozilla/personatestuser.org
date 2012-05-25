
const util = require('util'),
      events = require('events'),
      redis = require('redis'),
      wsapi = require('./wsapi_client');

var service = 'https://diresworb.org'
var config = {
  browserid: service,
  verifier: service + "/verify"
};

var redisClient = redis.createClient();

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
var Verifier = function Verifier(config) {
  events.EventEmitter.call(this);
  var self = this;
  self.config = config;

  this._getEmailPassword = function getEmailPassword(email, callback) {
    redisClient.get('ptu:'+email, function(err, pass) {
      console.log("password for " + email);
      return callback(err, pass);
    });
  };

  this._stagedEmailBecomesLive = function _stagedEmailBecomesLive (email, callback) {
    var multi = redisClient.multi();
    multi.zscore('ptu:emails:staged', email);
    multi.zrem('ptu:emails:staged', email);
    multi.exec(function(err, results) {
      if (err) return callback(err);
      var expires = results[0];
      return redisClient.zadd('ptu:emails', expires, email, callback);
    });
  };

  this.startVerifyingEmails = function startVerifyingEmails() {
    console.log("blpop ...");
    redisClient.blpop('ptu:mailq', 0, function(err, data) {
      // data is a tuple like [qname, data]
      try {
        data = JSON.parse(data[1]);
      } catch (err) {
        // bogus email
        self.startVerifyingEmails();
        return;
      }

      if (data.email && data.token) {

        // Get the user's password.  This will verify that 
        // we are staging this user
        self._getEmailPassword(data.email, function(err, pass) {
          if (!err && pass) {
            // Complete the user creation with browserid
            wsapi.post(self.config, '/wsapi/complete_user_creation', {}, { 
              token: data.token,
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
                self._stagedEmailBecomesLive(data.email, function(err) {
                  if (err) {
                    self.emit('error', err);
                  } else {
                    self.emit('user-created', data.email);
                  }
                });
                self.startVerifyingEmails();
              }
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
}
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

    return callback(null, res); 
  });
}

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
}

var stageUser = function stageUser(config, context, callback) {
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
}

var createUser = function createUser(config, email, pass, callback) {
  var context = {
    email: email, 
    pass: pass,
    site: 'http://personatestuser.org',
    keys: {}
  }

  getSessionContext(config, context, function(err) {
    if (err) return callback(err);

    getAddressInfo(config, context, function(err) {
      if (err) return callback(err);

      stageUser(config, context, function(err, url) {
        if (err) return callback(err);

        // Now we wait for an email to return from browserid.
        // The email will be received by bin/email, which will
        // push the email address and token pair into a redis
        // queue.  
        return callback(null);
      });
    });
  });
}

// the individual api calls
module.exports.getSessionContext = getSessionContext;
module.exports.getAddressInfo = getAddressInfo;
module.exports.stageUser = stageUser;

// higher-level compositions
module.exports.createUser = createUser;
module.exports.Verifier = Verifier;

