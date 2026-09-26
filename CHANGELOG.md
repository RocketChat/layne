# layne

## 2.0.0

### Major Changes

- [#116](https://github.com/RocketChat/layne/pull/116) [`d09bca0`](https://github.com/RocketChat/layne/commit/d09bca04071c6d918e4035f2ecdee162427f6c23) Thanks [@julio-rocketchat](https://github.com/julio-rocketchat)! - Introduce explicit scanner completion statuses, typed Git diffs, cooperative cancellation, startup configuration validation, and global scanner inheritance. Extend Dep Doctor lockfile health checks and baseline handling. Add bounded Spectre analysis with provider governors, validated response repair, opt-in signed caching, and opt-in AST routing. Replace count-based chat notifications with configurable final-state delivery. Add evidence-bound finding IDs and head-scoped bulk exception approvals.

  Incomplete scans now normally finish neutral instead of passing; unscanned high-risk Spectre overflow fails the check. Notifications default to high/critical findings, internal errors, and approvals; coverage notifications require opt-in. Custom adapters must adopt the structured result contract. Node 22.19 or newer is required.

- [#113](https://github.com/RocketChat/layne/pull/113) [`2460a1d`](https://github.com/RocketChat/layne/commit/2460a1d11b261b1231609f51077a4e2c872bb742) Thanks [@julio-rocketchat](https://github.com/julio-rocketchat)! - Skip draft pull requests by default across direct and deferred triggers, and handle ready_for_review events. Set trigger.scanOnDraft to true globally or per repository to preserve scanning drafts. Deferred CI workflows should subscribe to ready_for_review.

- [#90](https://github.com/RocketChat/layne/pull/90) [`c891508`](https://github.com/RocketChat/layne/commit/c8915081004704bded7d3226a89f8868e3109228) Thanks [@julio-rocketchat](https://github.com/julio-rocketchat)! - Replace Pi Agent with Spectre and add Dep Doctor scanner.

  - **Spectre** replaces Pi Agent as the multi-provider LLM malicious-intent scanner. It makes a single direct LLM call per file (no agent session) and supports Anthropic, OpenAI, Google, Mistral, and Amazon Bedrock via `@mariozechner/pi-ai`. Configurable file cap, diff line cap, min severity, skip paths/extensions, and concurrency.
  - **Dep Doctor** is a new dependency health scanner that fires when a lockfile changes. It detects newly-added packages with known CVEs (via OSV-Scanner), abandoned packages, and deprecated packages. Supports npm, PyPI, and Go lockfiles.
  - PR comments now use GitHub alert blocks (`[!CAUTION]` / `[!WARNING]`) with a severity-sorted findings table linking directly to the affected file and line. The `{{findings}}` and `{{severitySummary}}` template variables are now available for custom templates.
  - `Dockerfile` now installs `osv-scanner` alongside trufflehog and semgrep.

### Minor Changes

- [#59](https://github.com/RocketChat/layne/pull/59) [`53cdffc`](https://github.com/RocketChat/layne/commit/53cdffca67757d3827a5c42fb7d18599df4d819a) Thanks [@julio-rocketchat](https://github.com/julio-rocketchat)! - Adds a new feature that allows Pi Agent to lazy fetch repo files

- [#62](https://github.com/RocketChat/layne/pull/62) [`c3fa184`](https://github.com/RocketChat/layne/commit/c3fa1845e7ec77ca01faef2332212d74ff307fda) Thanks [@julio-rocketchat](https://github.com/julio-rocketchat)! - Ensure that Pi Agent retries once if the run returns buggy results

### Patch Changes

- [#115](https://github.com/RocketChat/layne/pull/115) [`f9e5ae8`](https://github.com/RocketChat/layne/commit/f9e5ae8c19f486c0651338cfa870272c146f6252) Thanks [@julio-rocketchat](https://github.com/julio-rocketchat)! - Upgrade documentation tooling to Docusaurus 3.10.0, refresh the Claude illustration, and repair local development links.

- [#61](https://github.com/RocketChat/layne/pull/61) [`f92ecc6`](https://github.com/RocketChat/layne/commit/f92ecc6fa8dc409e943daed3eb254396fd4143f4) Thanks [@julio-rocketchat](https://github.com/julio-rocketchat)! - Ensures that custom prompts can be used with Pi Agent

- [#114](https://github.com/RocketChat/layne/pull/114) [`c91fa3f`](https://github.com/RocketChat/layne/commit/c91fa3fd6540ba7885b8e81539a3457958a665d9) Thanks [@julio-rocketchat](https://github.com/julio-rocketchat)! - Install and remove temporary native build dependencies for Semgrep in Alpine images. Include build-time scripts required by the TypeScript build.

- [#112](https://github.com/RocketChat/layne/pull/112) [`eafd3d3`](https://github.com/RocketChat/layne/commit/eafd3d3cd78ade956da34939d20d91f101f61a48) Thanks [@julio-rocketchat](https://github.com/julio-rocketchat)! - Run Semgrep on complete selected HEAD files in diff-only mode, preserving syntax and enclosing context while filtering reported findings to changed lines.

- [#111](https://github.com/RocketChat/layne/pull/111) [`496f508`](https://github.com/RocketChat/layne/commit/496f508e735eb23d07336a2286087aab24800dc9) Thanks [@julio-rocketchat](https://github.com/julio-rocketchat)! - Validate HTTPS github.com clone destinations before attaching installation credentials or invoking Git. Reject existing credentials, non-default ports, query strings, and fragments.

## 1.3.0

### Minor Changes

- [#46](https://github.com/RocketChat/layne/pull/46) [`995fbc9`](https://github.com/RocketChat/layne/commit/995fbc999a932bb6220b6a843c0a676f63139662) Thanks [@julio-rocketchat](https://github.com/julio-rocketchat)! - Ensures that Pi Agent can support different providers and adds docs

- [#40](https://github.com/RocketChat/layne/pull/40) [`ff4acb6`](https://github.com/RocketChat/layne/commit/ff4acb65d25d5e444c2e88630fbe400c690546cc) Thanks [@julio-rocketchat](https://github.com/julio-rocketchat)! - Adds Pi Agent as an adapter

- [#45](https://github.com/RocketChat/layne/pull/45) [`2ee9fae`](https://github.com/RocketChat/layne/commit/2ee9fae512d176197547d274f47265c6991b37b1) Thanks [@julio-rocketchat](https://github.com/julio-rocketchat)! - Add line range prefix (e.g., `[R49-R60]`) to GitHub annotation messages for all security scanners

### Patch Changes

- [#50](https://github.com/RocketChat/layne/pull/50) [`6701cd6`](https://github.com/RocketChat/layne/commit/6701cd691cf6f8290ee30f3d09ea6902c3a0389c) Thanks [@julio-rocketchat](https://github.com/julio-rocketchat)! - Fix duplicate notifications being sent on every scan when exception approvals are active

- [#54](https://github.com/RocketChat/layne/pull/54) [`3d78f29`](https://github.com/RocketChat/layne/commit/3d78f2922fdae8ebde72d4b5962bdf751750f423) Thanks [@julio-rocketchat](https://github.com/julio-rocketchat)! - Checks if the PR has already been merged and doesn't run Layne

## 1.2.1

### Patch Changes

- [#38](https://github.com/RocketChat/layne/pull/38) [`eb7d3f6`](https://github.com/RocketChat/layne/commit/eb7d3f6e480c0546528d322fded402279864cbd2) Thanks [@julio-rocketchat](https://github.com/julio-rocketchat)! - Cache GitHub team member lookups for 30 minutes to avoid redundant API calls on every exception-approve command.

## 1.2.0

### Minor Changes

- **Exception Approvals**: Configure specific users or teams who can approve PRs that would otherwise fail the security scan. When an authorized approver approves a PR, Layne automatically re-runs the scan and passes it with a clear audit trail. Features include:
  - Automatic re-run on `pull_request_review` webhook when authorized approver approves
  - Team membership resolution via GitHub API
  - Approval validation against current commit SHA (new commits invalidate approvals)
  - Configurable exception labels (`onException`)
  - Always-on notifications for exception usage
  - Full audit trail in check run summary and chat notifications
  - See [Exception Approvals](./website/docs/exception-approvals.md) documentation

## 1.1.1

### Patch Changes

- [#18](https://github.com/RocketChat/layne/pull/18) [`3c06f0b`](https://github.com/RocketChat/layne/commit/3c06f0b90e2dafa5f5a42dbe3d3b7f858233020e) Thanks [@julio-rocketchat](https://github.com/julio-rocketchat)! - Fixes an issue in the Claude adapter that makes it hallucinate code lines when reporting it

## 1.1.0

### Minor Changes

- [`a88504d`](https://github.com/RocketChat/layne/commit/a88504d436bc0aafca94c94ee388560ca89c57c7) Thanks [@julio-rocketchat](https://github.com/julio-rocketchat)! - Changes the documentation to add security architecture and PR guidelines

- [#4](https://github.com/RocketChat/layne/pull/4) [`f2de34f`](https://github.com/RocketChat/layne/commit/f2de34f83c26dd5738cc86b82573496f4e3c565f) Thanks [@julio-rocketchat](https://github.com/julio-rocketchat)! - Adds a new trigger for Layne: workflow_run

- [#2](https://github.com/RocketChat/layne/pull/2) [`e0b5410`](https://github.com/RocketChat/layne/commit/e0b5410b132a54da4ce132616d67fa382279c9ed) Thanks [@julio-rocketchat](https://github.com/julio-rocketchat)! - Adds the Slack notifier and support to Slack notifications via webhooks
