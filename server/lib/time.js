
/*
 * Use this to ge the current date.  We store all our timestamps as
 * seconds since the epoch, not milliseconds.
 */
var unixTime = module.exports.unixTime = function unixTime() {
  return Math.floor(Date.now() / 1000);
};