/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const redis    = require('redis');

var redisErrorCount = 0;

exports.createClient = function() {
  var client = redis.createClient();

  client.on('error', function(err) {
    // The error has to be handled or else node restarts the server. Not ideal.
    console.log("REDIS error", redisErrorCount, err);
    redisErrorCount++;
  });

  return client;
};

