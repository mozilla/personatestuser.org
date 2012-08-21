personatestuser.org is a service that makes it easy to write automated tests of
persona login on your site.

## Overview

This system furnishes an API for creating temporary Persona accounts.
The email accounts intended for testing the Persona service.  They are
valid for two hours, after which time they will automatically be
canceled.  Specifically, the API permits you to:

- Get a new verified email and password
- Get a new unverivied email and password
- Get a new verified email, password, and assertion for a certain audience
- Get an assertion for a certian audience using an existing email
- Delete an email account (happens automatically on expiration)

Some of these functions can be performed directly in the web console,
but it is assumed that the most common use cases will depend on `curl`
or programmatic approaches.

## API

The queries are all HTTP GETs; they return JSON.  Sometimes, an
optional final argument *env* may be applied.  This may be one of
`prod`, `dev`, `stage`, and `local`.  It specifies which development
environment to query.

All queries return a JSON string on success with some or all of the
following fields:

- `email` An email to use as an identity
- `pass` The password for the account
- `token` A verification token for use with the identity provider
- `expires` Expiration date in seconds since the epoch
- `env` The name of the server environment ("prod", "dev", "stage", or "local")
- `browserid` The url for the IdP specified by env
- `verifier` The url for the verifier specified by env
- `audience` The audience an assertion is valid for
- `assertion` An identity assertion for a given audience
- `cert` An identity certificate from the IdP for the email
- `bundle` A bundled assertion and certificate

### New Verified Email

    GET /email[/<env>]

Creates an identity that will be valid for an hour.

### New Unverified Email

    GET /unverified_email[/<env>]

Stages a new identity with the IdP.  Use the returned verification
token to complete the account creation.

### New Assertion and Email

    GET /email_with_assertion/<audience>[/<env>]

Get a new verified email and an assertion, valid for two minutes, for
the named audience.

Audience must include the protocol (`https://`) and be url-encoded.
For example, rather than `jedp.gov`, the audience would be
`https%3A%2F%2fjedp.gov`.  (Though this is a bit cumbersome, we prefer
that the input you're sending to the BrowserID verifier be completely
transparent.)

### New Assertion

Like the above, but with explicit parameters for an existing email and
password.  Does not create a new account.

    GET /assertion/<audience>/<email>/<password>

Note that *env* is not an option, since the email has already been
created for a certain server environment.

Again, the audience must include the protocol and be url-encoded.

### Cancel Account

    GET /cancel/<email>/<password>

Cancel the email account for given email and password.  Note that
*env* is not an option in this query, since the email has already
been create for a certain env.

You do not need to cancel accounts created with this tool.  Email
accounts are automatically canceled with the IdP after one hour.




