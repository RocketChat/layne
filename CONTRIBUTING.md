# Contributing to Layne

Thanks for your interest in contributing. This document covers the branch model, PR workflow, and release process. For setting up a local development environment, see [docs/3-local-development.md](docs/3-local-development.md).

---

## Branch model

| Branch | Purpose |
|---|---|
| `develop` | Default branch. All PRs and releases flow through here. |

**Release flow:**
1. As PRs merge to `develop`, the changeset bot opens and maintains a **"chore: release vX.Y.Z"** PR targeting `develop`
2. Merging that PR to `develop` creates a GitHub release automatically

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

## What makes a good PR

- **One thing per PR.** If you find yourself writing "and also..." in the description, split it.
- **Explain the why.** The diff shows what changed. The description should say why.
- **Every behaviour change needs a test.** If you're fixing a bug, the test should fail on the old code.
- **Security-sensitive areas get extra scrutiny** — webhook verification, auth, file path handling, scanner output parsing. Explain your threat model.

**Example description:**

```
Fix scanner timeout not being applied to Claude batches

The 10-minute job timeout in worker.js wraps the full runScan() call,
but individual Claude API batches had no timeout of their own. A hung
API call would block the worker until the top-level timeout fired,
tying up a concurrency slot for the full 10 minutes.

Added a per-batch 90-second timeout via Promise.race. Batches that
exceed it log a warning and return { error: true } so the rest of
the scan continues.

Closes #42
```

---

## Tests and lint

```bash
npm test                  # run the full test suite
npm run test:watch        # watch mode during development
npm run lint              # ESLint
npm run validate-config   # validate config/layne.json schema
```

All four must pass before a PR can be merged.

---

## Extending Layne

- **Adding a new scanner:** see [docs/6-extending.md — Adding a New Scanner](docs/6-extending.md#adding-a-new-scanner)
- **Adding a notification provider:** see [docs/6-extending.md — Adding a New Notifier](docs/6-extending.md#adding-a-new-notifier)

---

## Security issues

Please do not open a GitHub issue for security vulnerabilities. See [SECURITY.md](SECURITY.md) for the responsible disclosure policy.
