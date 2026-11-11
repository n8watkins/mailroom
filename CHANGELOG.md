# Changelog

## 0.3.0 - 2026-11-11

### New

- An all-app monthly cap keeps email inside what Workers Paid includes, so it never bills ([#12](https://github.com/n8watkins/mailroom/pull/12))
- Get an email at 70, 85, 95 and 100% of the monthly cap, and when the daily cap is hit ([#13](https://github.com/n8watkins/mailroom/pull/13))
- Tend sends through mailroom with a 150 a month slice ([#14](https://github.com/n8watkins/mailroom/pull/14))
- The n8builds.dev newsletter sends through mailroom with a 150 a month slice ([#15](https://github.com/n8watkins/mailroom/pull/15))

## 0.2.0 - 2026-11-10

### New

- Run your own mailroom: apps and Cloudflare resources move into a per-deployment config ([#9](https://github.com/n8watkins/mailroom/pull/9))

## 0.1.0 - 2026-11-10

### New

- First release: one Worker sends every app's email through
- The usage view now counts every app's emails this month
- The owner can now see recent sends and suppressions, pause
- PR Post's paper now hears about bounced and complained

### Fixed

- Sending is stricter about malformed senders and headers,

