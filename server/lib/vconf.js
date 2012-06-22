module.exports = {
  prod: {
    browserid: 'https://browserid.org',
    verifier: "https://browserid.org/verify"
  },
  stage: {
    browserid: 'https://diresworb.org',
    verifier: "https://diresworb.org/verify"
  },
  dev: {
    browserid: 'https://login.dev.anosrep.org',
    verifier: "https://verifier.dev.anosrep.org"
  },

  // For testing, run browserid on localhost
  // XXX not complete - email delivery
  local: {
    browserid: 'http://localhost:10007/',
    verifier: 'http://localhost:10002/'
  }
};
