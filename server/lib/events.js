const redis = require('redis'),
      db = redis.createClient();

/**
 * Print something to the console and maybe log it to an event stream
 *
 * @param text
 *        (string)    The string to log.  Note: If you're logging an
 *                    error object, be sure to call its toString() method
 *                    in the caller.
 *
 * @param email
 *        (string)    Optional.  If provided, record the given text in the
 *                    email's event stream with millisecond timestamp.
 */
var logEvent = module.exports.logEvent = function logEvent(text, email) {
  // print it
  console.log(text);

  // if there's an email associated, add to the event stream
  if (email) {
    db.zadd('ptu:events:'+email, Date.now(), text);
  }
};

/**
 * Asynchronously return a list of tuples of events and timestamps.
 *
 * @param email
 *        (string)    The email address to get events for
 *
 * @param start
 *        (int)       Millisecond timestamp of earliest event.
 *
 * @param callback
 *        (function)  Function to call with list of events.
 */
var fetchEvents = module.exports.fetchEvents = function fetchEvents(email, start, callback) {
  db.zrangebyscore('ptu:events:'+email, start, Infinity, 'WITHSCORES', function(err, results) {
    if (err) {
      return callback(err, []);
    }

    var stream = [];
    for (var i=0; i<results.length; i+=2) {
      stream.push([results[i], parseFloat(results[i+1]) - start]);
    }
    return callback(null, stream);
  });
};