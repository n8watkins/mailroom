# Agent instructions

## Deployments

- The root `wrangler.jsonc` and `apps.config.ts` are the template others start from: keep them generic (example.com, placeholders).
- The owner's live mailroom is `deployments/n8builds/` (`wrangler.jsonc` and `apps.ts`). App, sender, cap and hook changes for his apps go there.
- Deploy it with `npm run deploy -- deployments/n8builds/wrangler.jsonc`. A bare `npm run deploy` targets the template and stops at its placeholders.
- `npm test` checks every deployment's apps against its wrangler config, and `npm run check:deploy` dry-runs every deployment.

<!-- release-kit -->
## Commits and releases

- Write every commit message as a Conventional Commit: `type(scope): subject`, with type one of feat, fix, perf, security, refactor, docs, test, build, ci, chore, style, revert. A hook and a CI check reject anything else; see RELEASING.md.
- Use `feat` and `fix` only for changes a user would notice: they become the release notes and the public build log.
- Write those subjects as patch notes, for users: what they can now do or what works better, not the file, library or test you touched. When the subject must stay technical, add a `Release-note: <plain sentence>` line to the body, or `Release-note: skip` for a change no user would notice.
- Don't bump versions, edit CHANGELOG.md or releases.json, or create tags by hand: `npm run release` does all of it.
- Land changes through pull requests: a pre-push hook blocks pushing straight to main or a release branch, force pushes and moving release tags. Don't get around it with `--no-verify` or `RELEASE_KIT_ALLOW_DIRECT_PUSH=1` (that is for emergencies the owner asks for, and a Direct push alarm reports it either way).
<!-- /release-kit -->
