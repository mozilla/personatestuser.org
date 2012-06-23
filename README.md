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

    GET /email/verified[/<env>]

Get a verified email and password.

    GET /email/unverified[/<env>]

Get an unverified email, password, and verification token.

    GET /assertion/<audience>[/<env>]

Get a new verified email and an assertion, valid for two minutes, for
the named audience.

    GET /assertion/<audience>/email/<email>/password/<password>

[Not implemented yet]  
With the specified email and password, get an assertion, valid for two
minutes, for the named audience.  Note that *env* is not an option,
since the email has already been created for a certain server
environment.

    GET /cancel/email/<email>/password/<password>

Cancel the email account for given email and password.  Note that
*env* is not an option in this quiery, since the email has already
been create for a certain env.




