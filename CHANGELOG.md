# layne

## 1.2.0

### Minor Changes

- [#27](https://github.com/RocketChat/layne/pull/27) [`25248cc`](https://github.com/RocketChat/layne/commit/25248cca3658ecbf5aae3cdfd3eff0187af7cb3f) Thanks [@julio-rocketchat](https://github.com/julio-rocketchat)! - Adds a new diff_only mode and allows mode to be configured

- [#35](https://github.com/RocketChat/layne/pull/35) [`23f1b32`](https://github.com/RocketChat/layne/commit/23f1b32cfb0092330d2fe467e7d6c45993bd7a83) Thanks [@julio-rocketchat](https://github.com/julio-rocketchat)! - Rewrites the codebase from JavaScript to TypeScript for improved type safety and developer experience. No behavioral changes; deployment, configuration schema, and all external interfaces are identical.

- [#22](https://github.com/RocketChat/layne/pull/22) [`294d984`](https://github.com/RocketChat/layne/commit/294d9840a732154610e9be8141609a85732f4d63) Thanks [@julio-rocketchat](https://github.com/julio-rocketchat)! - Adds a new feature that allows exceptions to be approved by specific teams or people

- [#29](https://github.com/RocketChat/layne/pull/29) [`2427573`](https://github.com/RocketChat/layne/commit/242757385abd1b45607b8b97ccf7987c4e0cd3e1) Thanks [@julio-rocketchat](https://github.com/julio-rocketchat)! - Makes timeouts configurable on global and per repo levels

- [#34](https://github.com/RocketChat/layne/pull/34) [`8a4126f`](https://github.com/RocketChat/layne/commit/8a4126f07c33621b1b8c58cf57cb7707a61ac67b) Thanks [@julio-rocketchat](https://github.com/julio-rocketchat)! - Adds support for warnings for commenter as well as rule names

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

- [#15](https://github.com/RocketChat/layne/pull/15) [`e000196`](https://github.com/RocketChat/layne/commit/e00019655f2e9f5ade9e9be07ff92a176fa93d93) Thanks [@julio-rocketchat](https://github.com/julio-rocketchat)! - Adds support for creating comments in the PRs

- [#13](https://github.com/RocketChat/layne/pull/13) [`4c19ba0`](https://github.com/RocketChat/layne/commit/4c19ba0c4f758c90ab6fb1161f8999a97510865f) Thanks [@julio-rocketchat](https://github.com/julio-rocketchat)! - Adds a new suppressor feature to ignore findings with a "// SECURITY: XYZ" comment

## 1.0.0

### Major Changes

- [#6](https://github.com/RocketChat/layne/pull/6) [`a11a412`](https://github.com/RocketChat/layne/commit/a11a412371973a812e90a563152cf7ac6c0c7f43) Thanks [@julio-rocketchat](https://github.com/julio-rocketchat)! - Adds support for workflow jobs alongside workflow runs

- [#8](https://github.com/RocketChat/layne/pull/8) [`62af89e`](https://github.com/RocketChat/layne/commit/62af89e72a98c597d8524e8d88bcf67c29954a16) Thanks [@julio-rocketchat](https://github.com/julio-rocketchat)! - Fixes a bug in which Layne ends up scanning files that are unrelated to the PR

- [#10](https://github.com/RocketChat/layne/pull/10) [`cafaf75`](https://github.com/RocketChat/layne/commit/cafaf7584beb145977aa5ebcce7672273098fdee) Thanks [@julio-rocketchat](https://github.com/julio-rocketchat)! - Fixes an issue that wouldn't reschedule a Layne scan if there's an existing failed scan

- [`a88504d`](https://github.com/RocketChat/layne/commit/a88504d436bc0aafca94c94ee388560ca89c57c7) Thanks [@julio-rocketchat](https://github.com/julio-rocketchat)! - Changes the documentation to add security architecture and PR guidelines

- [#4](https://github.com/RocketChat/layne/pull/4) [`f2de34f`](https://github.com/RocketChat/layne/commit/f2de34f83c26dd5738cc86b82573496f4e3c565f) Thanks [@julio-rocketchat](https://github.com/julio-rocketchat)! - Adds a new trigger for Layne: workflow_run

- [#2](https://github.com/RocketChat/layne/pull/2) [`e0b5410`](https://github.com/RocketChat/layne/commit/e0b5410b132a54da4ce132616d67fa382279c9ed) Thanks [@julio-rocketchat](https://github.com/julio-rocketchat)! - Adds the Slack notifier and support to Slack notifications via webhooks
