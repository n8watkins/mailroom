# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately, not in a public issue.
Use GitHub's [private vulnerability reporting](https://github.com/n8watkins/mailroom/security/advisories/new) (the "Report a vulnerability" button on the Security tab).
Include what you found, the affected file or entrypoint, and steps to reproduce.

You should hear back within 5 business days.
Only the latest release and the `main` branch get fixes.

## What counts

mailroom's job is to keep one app from sending as another, to keep every app inside its caps, and to keep recipient addresses and email content out of anything it returns or logs.
A way around any of that is a vulnerability, for example:

- sending with a sender or kind the app's config doesn't allow, or past a cap;
- mailing an address on the suppression list;
- an admin read that returns a full address or email content;
- header or display-name injection through `send()`.

Out of scope: anything that needs deploy access to the Cloudflare account.
Any Worker in the account can bind to mailroom with any `props.app`, by design (README, "The trust model").
