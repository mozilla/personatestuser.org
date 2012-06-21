var redis = require('redis');

  // get default config from env
var conf = {
  redis_host: process.env["REDIS_HOST"] || "127.0.0.1",
  redis_port: parseInt(process.env["REDIS_PORT"] || "6379", 10)
};

var getRedisClient = module.exports.getRedisClient = function getRedisClient() {
  var redisClient = redis.createClient(conf.redis_port, conf.redis_host);

  redisClient.on('error', function(err) {
    console.log("ERROR: Redis client: " + err);
  });
  return redisClient;
};
