## What

personatestuser.org is a service that makes it easy to write automated tests of
persona login on your site.

## Proposed API

    GET /test_user - retrieve a random persona email/password pair for testing, valid for 1 hour
    GET /assertion/<email>/<password>/<audience> - get an assertion, valid for 2 minutes, for a specific site

## Proposed Goals

  1. deletion isn't necessary, it can happen automatically
  2. getting an assertion should be a phase 1 requirement
  3. this can all be implemented on a different domain/VM - personatestusers.com or something
  4. users of this system don't get to choose the email or password, it's randomly chosen

