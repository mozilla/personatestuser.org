var vows = require('vows');
var assert = require('assert');
var request = require('request');
var path = require('path');
var spawn = require('child_process').spawn;
var uscore = require('underscore');

var env = uscore.clone(process.env);

// Always use the same port so we get immediate feedback
// if the previous test run didn't clean up properly.
var host = "127.0.0.1";
var port = env['PORT'] || 3042;

var appProcess;
process.on('exit', function() {
  if (appProcess) {
    appProcess.kill();
  }
});

function getJSON(urlPath, callback) {
  var uri = 'http://' + host + ':' + port + urlPath;
  request.get({
    uri: uri
  }, function(err, res, body) {
    if (err) return callback(err);
    try {
      return callback(null, JSON.parse(body));
    } catch (err) {
      return callback(err);
    }
  }).on('error', callback);
}

vows.describe("HTTP app server")

/*
 * setup server
 */
.addBatch({
  "Start server": {
    topic: function() {
      var cb = this.callback;
      var appExec = path.join(__dirname, '..', 'server', 'bin', 'app');

      appProcess = spawn('node', [appExec], {env: env});

      appProcess.stdout.on('data', function(buf) {
        buf.toString().split("\n").forEach(function(line) {
          if (/personatestuser listening/.test(line)) {
            return cb(null, true);
          }
        });
      });
    },

    "ok": function(started) {
      assert(started);
    }
  }
})

.addBatch({
  "verifyEnv middleware": {
    topic: function() {
      getJSON('/email/foo', this.callback);
    },

    "ok": function(err, res) {
      assert(err === null);
      assert(res.error);
    }
  }
})

/*
 * tear down server
 */
.addBatch({
  "Stop server": {
    topic: function() {
      var cb = this.callback;
      appProcess.on('exit', function() {
        return cb(null, true);
      });
      appProcess.on('error', function(err) {
        return cb(err);
      });
      appProcess.kill('SIGINT');
    },

    "ok": function(stopped) {
      assert(stopped);
    }
  }
})

.export(module);