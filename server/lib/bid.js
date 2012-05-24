
const wsapi = require('./wsapi_client');

var service = 'https://diresworb.org'
var config = {
  browserid: service,
  verifier: service + "/verify"
};

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
    if (err) return callback(err);

    if (res.code !== 200) {
      return callback(new Error("Can't stage user: server status " + res.code));
    }

    return callback(null, res);
  });
}

var createUser = function createUser(config, email, pass, callback) {
  var context = {keys: {}}

  getSessionContext(config, context, function(err, res) {
    if (err) return callback(err);

    getAddressInfo(config, context, function(err, res) {
      if (err) return callback(err);

      stageUser(config, context, function(err, res) {
        if (err) return callback(err);

        // that should be a 200
        // now expect an email within 5 seconds
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
