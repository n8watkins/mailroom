# Contributing

Thanks for taking a look.
Bug reports, fixes and small focused features are welcome.
For anything bigger, open an issue first so we can agree on the shape before you build it.

## Setup

```bash
npm install
npm test               # workerd and a local D1; nothing is ever sent
npm run typecheck
npm run check:deploy   # dry run of every deployment
```

You don't need a Cloudflare account to run any of these.

## Pull requests

- Keep the template generic: `wrangler.jsonc` and `apps.config.ts` use example.com and placeholders.
  Your own deployment belongs in your fork (`deployments/<name>/`), not in a PR.
- Add or update a test for any change in behavior.
  `test/apps.ts` holds the apps the tests run with.
- Schema changes go in a new file in `migrations/`, never an edit to one that has shipped.
- Commit messages are [Conventional Commits](https://www.conventionalcommits.org/) (`fix: ...`, `feat: ...`).
  A CI check enforces it, and `feat` and `fix` subjects become the release notes, so write them for the people running mailroom.
- Never put real addresses, keys or account details in code, tests or issues.

Security problems go through [SECURITY.md](SECURITY.md), not an issue.

By contributing you agree that your work is released under the [MIT License](LICENSE).
