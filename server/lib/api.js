const redis = require('redis'),
      DEFAULT_DOMAIN = 'personatestuser.org',
      TEN_MINUTES_IN_MS = 10 * 60 * 1000;

// All our redis keys are prefixed with 'ptu:'
//
// ptu:nextval = an iterator
// ptu:emails = zset of user emails scored by creation date
// ptu:<email> = password for user with given email
var redisClient = redis.createClient();

module.exports.getTestUser = function getTestUser(callback) {
  // pick a unique username and assign a random password.
  try {
    var name = getRandomName();
    var password = getRandomPassword();
    var email;

    redisClient.incr('ptu:nextval', function(err, val) {
      email = name + val + '@' + DEFAULT_DOMAIN;
      var created = (new Date()).getTime();
      var expires = created + TEN_MINUTES_IN_MS;

      var multi = redisClient.multi();
      multi.zadd('ptu:emails', expires, email);
      multi.set('ptu:'+email, password);
      multi.exec(function(err) {
        if (err) return callback(err);
        return callback(null, {
          'email': email, 
          'password': password,
          'expires': expires
        });
      });
    });

  } catch (err) {
    return callback(err);
  }
};

module.exports.deleteTestUser = function deleteTestUser(email, callback) {
  try {
    var multi = redisClient.multi();
    multi.del('ptu:'+email);
    multi.zrem('ptu:emails', email);
    multi.exec(callback);
  } catch (err) {
    return callback(err);
  }
};

module.exports.getAssertion = function getAssertion(params, callback) {
  try{
    var email = params.email;
    var password = params.password;
    var audience = params.audience;
    if (! email && password && audience) {
      return callback(new Error("required param missing"));
    }

    return callback(null, {
      'assertion': 'I like pie'
    });
  } catch (err) {
    return callback(err);
  }
};

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
            '~#$%^&*(){}[]_+-=,.;: ';

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

