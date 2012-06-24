var conf = module.exports = {
  redis_host: process.env["REDIS_HOST"] || "127.0.0.1",
  redis_port: parseInt(process.env["REDIS_PORT"] || "6379", 10)
};
