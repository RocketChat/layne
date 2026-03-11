# Contributing to Layne

Thanks for your interest in contributing. This document covers the branch model, PR workflow, and release process. For setting up a local development environment, see [docs/local-development.md](docs/local-development.md).

---

## Branch model

| Branch | Purpose |
|---|---|
| `develop` | Default branch. All PRs target here. |
| `main` | Releases only. Never commit directly. |

**Release flow:**
1. As PRs merge to `develop`, the changeset bot opens and maintains a **"chore: release vX.Y.Z"** PR targeting `main`
2. Merging that PR to `main` triggers a deploy and creates a GitHub release automatically
3. A **"chore: sync main → develop"** PR is then opened automatically — merge it to keep `develop` up to date

---

## Opening a PR

1. **Branch off `develop`**
   ```bash
   git checkout develop && git pull
   git checkout -b my-feature
   ```

2. **Make your changes and write tests.** All PRs must pass `npm run lint`, `npm run validate-config`, and `npm test`.

3. **Add a changeset** (see below)

4. **Open the PR against `develop`**

---

## Changesets

Every PR that changes behaviour needs a changeset — a small file that describes what changed and what kind of version bump it warrants. The changeset check CI will fail if one is missing.

**Add a changeset:**
```bash
npm run changeset
```

This prompts you to pick a bump type and write a one-line description, then writes a file to `.changeset/`. Commit that file with your PR.

**Bump types:**

| Type | When to use |
|---|---|
| `patch` | Bug fixes, internal refactors with no behaviour change, dependency bumps |
| `minor` | New features, new config options, new scanner support |
| `major` | Breaking changes to config format, removed options, changed defaults |

**Skipping the changeset:**

For PRs that don't warrant a release entry — CI fixes, typos, documentation updates — add the `no-changeset` label to the PR. The check will be skipped.

---

## Tests and lint

```bash
npm test                  # run the full test suite
npm run test:watch        # watch mode during development
npm run lint              # ESLint
npm run validate-config   # validate config/repos.json schema
```

All four must pass before a PR can be merged.

---

## Extending Layne

- **Adding a new scanner:** see [docs/extending.md — Adding a New Scanner](docs/extending.md#adding-a-new-scanner)
- **Adding a notification provider:** see [docs/extending.md — Adding a New Notification Provider](docs/extending.md#adding-a-new-notification-provider)

---

## Security issues

Please do not open a GitHub issue for security vulnerabilities. See [SECURITY.md](SECURITY.md) for the responsible disclosure policy.
