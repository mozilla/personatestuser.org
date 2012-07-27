module.exports = {
  prod: {
    browserid: 'https://login.persona.org',
    verifier: "https://login.persona.org/verify"
  },
  stage: {
    browserid: 'https://login.anosrep.org',
    verifier: "https://login.anosrep.org/verify"
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
