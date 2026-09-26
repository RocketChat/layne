# Exception Approvals

Layne can be configured to allow specific users or teams to approve findings that would otherwise block a PR. Approvers can select finding IDs or approve all remaining blocking findings from the current failed scan. This is useful for accepted risks, false positives, or hotfixes that need to merge quickly.

Exceptions are **deliberate and auditable** - the approver must select exact finding ID(s) or explicitly use `all`, and must provide a written reason. This is intentionally separate from a generic PR approval.

## How It Works

1. Layne runs a scan and finds blocking findings (critical/high severity)
2. The check run fails with `conclusion: failure`
3. The check run summary lists each blocking finding with its ID and a ready-to-copy command
4. An authorized approver posts a PR comment with the command:
   ```
   /layne exception-approve LAYNE-v2-a3f29c81b7e41d22 reason: test credential, will be rotated before release
   ```
5. Layne receives the `issue_comment` webhook, validates the command and the approver's authorization
6. Layne stores the exception in Redis (scoped to the PR) and re-runs the scan
7. The check run passes with `conclusion: success` and a summary listing who excepted each finding and why, provided scan coverage completed

Exceptions survive new commits while the finding's rule and evidence remain the same; Layne resolves unrelated line-number drift caused by rebases, base-branch merges, or changes elsewhere. Modifying the flagged evidence or changing the rule identity invalidates the exception and requires a new approval.

Exceptions waive specific findings, not scanner coverage. If an enabled adapter is ordinarily incomplete, approving every blocking finding changes the final conclusion to `neutral`, not `success`. If Spectre leaves score-12-or-higher files unscanned after both file caps are full, the final conclusion remains `failure`. The exception remains recorded in the summary and audit trail, but Layne will not claim a complete clean scan or waive the high-risk coverage failure.

## The Command

Post a comment on the PR containing one of the following on a single line:

```
/layne exception-approve <ID> [<ID> ...] reason: <explanation>
/layne exception-approve all reason: <explanation>
```

| Part | Description |
|---|---|
| `/layne exception-approve` | Required trigger prefix |
| `<ID>` | One or more finding IDs in `LAYNE-v2-xxxxxxxxxxxxxxxx` format (from the check run summary) |
| `all` | All remaining actionable critical/high findings produced by the approval re-scan on the current head |
| `reason: <explanation>` | Required - free-text explanation; recorded in the audit trail |

**Multiple findings in one command:**
```
/layne exception-approve LAYNE-v2-a3f29c81b7e41d22 LAYNE-v2-b7e41d22a3f29c81 reason: legacy code, tracked in JIRA-1234
```

**All remaining blocking findings:**
```
/layne exception-approve all reason: accepted risk for the emergency release
```

`all` is one-shot and head-scoped. Layne re-runs the scan, resolves existing exceptions, and materializes ordinary per-finding exceptions for the remaining actionable critical/high findings. The exact resulting ID list is stored atomically. A retry cannot expand that list, and findings introduced by a later commit require a new approval. Existing per-finding approvals keep their original approver and reason. `all` cannot be combined with finding IDs and never waives incomplete or blocking scanner coverage.

Bulk approval requires a failed Layne Check Run on the current head. If another scan is already running for that commit, wait for it to finish and retry the command.

The command can appear anywhere in the comment body - other text before or after it is ignored.

## Finding IDs

Each finding gets a deterministic `LAYNE-v2-xxxxxxxxxxxxxxxx` ID derived from the tool, rule ID, file, line, and a digest of its evidence. The ID remains stable while those identity fields remain unchanged. Moving the finding, changing its evidence, or changing the rule creates a new ID. Legacy `LAYNE-xxxxxxxxxxxxxxxx` IDs remain accepted for stored-exception migration, but new Check Run summaries emit v2 IDs.

## Check Run Summary

When exception approvers are configured, the check run summary includes the finding IDs and a copy-paste command.

**On failure (no exceptions yet):**
```
Found 2 issue(s): 0 critical, 2 high, 0 medium, 0 low.

Blocking findings:
- LAYNE-v2-a3f29c81b7e41d22 [trufflehog/aws-key] src/config.js:42
- LAYNE-v2-b7e41d22a3f29c81 [semgrep/eval] src/api.js:88

To approve all blocking findings, post:
/layne exception-approve all reason: <explanation>

To approve selected findings, post:
/layne exception-approve LAYNE-v2-a3f29c81b7e41d22 LAYNE-v2-b7e41d22a3f29c81 reason: <explanation>
```

**On failure (partial exceptions):**
```
Found 2 issue(s): 0 critical, 2 high, 0 medium, 0 low.

Blocking findings (1 remaining):
- LAYNE-v2-b7e41d22a3f29c81 [semgrep/eval] src/api.js:88

Already excepted (1):
- LAYNE-v2-a3f29c81b7e41d22 - excepted by @alice: "test credential"

To approve all remaining findings, post:
/layne exception-approve all reason: <explanation>

To approve selected findings, post:
/layne exception-approve LAYNE-v2-b7e41d22a3f29c81 reason: <explanation>
```

**On success (all excepted and coverage complete):**
```
⚠️ Scan passed with excepted findings.

Found 2 issue(s): 0 critical, 2 high, 0 medium, 0 low.

Excepted findings:
- LAYNE-v2-a3f29c81b7e41d22 [trufflehog/aws-key] src/config.js:42 - excepted by @alice: "test credential, will be rotated"
- LAYNE-v2-b7e41d22a3f29c81 [semgrep/eval] src/api.js:88 - excepted by @bob: "legacy code, tracked in JIRA-1234"

All findings are still annotated below for reference.
```

## Configuration

Configure exception approvers in `config/layne.json`:

```json title="config/layne.json"
{
  "$global": {
    "exceptionApprovers": {
      "users": ["security-lead"],
      "teams": ["acme/security-team"]
    }
  }
}
```

| Key | Type | Description |
|---|---|---|
| `users` | string[] | GitHub usernames who can post exception commands |
| `teams` | string[] | GitHub team slugs (format: `org/team-slug`) whose members can post exception commands |

### Per-Repo Override

Per-repo `exceptionApprovers` **replaces** the global configuration - it does not merge:

```json title="config/layne.json"
{
  "$global": {
    "exceptionApprovers": {
      "users": ["security-lead"],
      "teams": ["acme/security-team"]
    }
  },
  "acme/payments": {
    "exceptionApprovers": {
      "users": ["payments-security-lead"],
      "teams": ["acme/payments-security"]
    }
  }
}
```

### Disabling for a Repository

To disable exception approvals for a specific repository, set empty arrays:

```json title="config/layne.json"
{
  "$global": {
    "exceptionApprovers": {
      "users": ["security-lead"]
    }
  },
  "acme/critical-service": {
    "exceptionApprovers": {
      "users": [],
      "teams": []
    }
  }
}
```

## Labels

When an exception is used and the final conclusion is `success`, Layne can automatically add or remove labels on the PR:

```json title="config/layne.json"
{
  "$global": {
    "labels": {
      "onException":       ["security-exception-used"],
      "removeOnException": ["needs-security-review"]
    }
  }
}
```

| Key | Description |
|---|---|
| `onException` | Labels to add when an exception approval is used |
| `removeOnException` | Labels to remove when an exception approval is used |

If ordinary coverage is incomplete, Layne uses the configured `onIncomplete` and `removeOnIncomplete` labels instead. A high-risk Spectre file-cap coverage failure uses `onFailure` and `removeOnFailure`. See [Configuration - Labels](configuration.md#labels).

## Notifications

Effective partial and full approvals are included in the final notification state. Notification deduplication tracks the approved finding IDs rather than the total finding count, and the message includes the final Check Run conclusion when other findings or incomplete coverage remain.

## Security Considerations

| Concern | Mitigation |
|---|---|
| Compromised approver account | Require 2FA on GitHub; follow org security policies |
| Team membership escalation | Audit team membership regularly; use CODEOWNERS |
| Config tampering | Protect `config/layne.json` with CODEOWNERS and branch protection |
| Approval for changed code | Exceptions are invalidated when the flagged line changes - only unrelated commits (rebases, merges from the base branch) preserve approvals |
| Bulk approval expanding unexpectedly | `all` is bound to one head and atomically records its exact materialized finding IDs; retries and later commits cannot add findings |
| Silent approvals | A reason is required and recorded; completed approvals notify configured channels even when the finding count is unchanged |
| Unauthorized command | Commands from non-approvers are silently ignored - no reply, no re-scan |

## Audit Trail

Every exception is recorded in:

1. **GitHub Check Run summary** - lists each excepted finding ID, who approved it, and the stated reason
2. **PR comment thread** - the approver's command and Layne's confirmation reply are visible to all reviewers
3. **PR label** - `security-exception-used` after a successful completed approval, if configured; ordinary incomplete scans use incomplete labels and blocking coverage failures use failure labels
4. **Chat notification** - sent to configured notifiers when the approval-triggered re-scan has all blocking findings excepted

## GitHub App Permissions

Layne needs these permissions for exception approvals to work:

| Permission | Why |
|---|---|
| `issues: write` | To post confirmation and error reply comments |
| `organization_members: read` | To resolve team membership when `teams` is configured |

The `issue_comment` webhook event must be subscribed to in your GitHub App settings.

## Workflow

```
Developer opens PR with vulnerability
             ↓
Layne scans → finds critical/high issue
             ↓
Check run: FAILURE ❌
Summary includes finding IDs and copy-paste command
             ↓
Authorized approver posts:
/layne exception-approve LAYNE-v2-a3f29c81b7e41d22 reason: accepted risk
             ↓
Layne validates command and authorization
             ↓
Exception stored in Redis (scoped to the PR), or an `all` request is materialized into exact finding IDs
Layne re-runs the scan
             ↓
All blocking findings excepted and coverage complete → PASS with audit note
             ↓
Check run: SUCCESS ⚠️
```

## Example

**Config:**
```json
{
  "$global": {
    "exceptionApprovers": {
      "users": ["alice", "bob"],
      "teams": ["acme/security"]
    },
    "labels": {
      "onException": ["security-exception-used"]
    }
  }
}
```

**Scenario:**
1. Developer opens PR #42 with a hardcoded API key (Trufflehog finding)
2. Layne scan fails with `conclusion: failure`; summary shows `LAYNE-v2-a3f29c81b7e41d22` and the copy-paste command
3. Bob (authorized user) posts:
   ```
   /layne exception-approve LAYNE-v2-a3f29c81b7e41d22 reason: test credential, rotating before release
   ```
4. Layne replies: `✅ Exception recorded for LAYNE-v2-a3f29c81b7e41d22 by @bob: "test credential, rotating before release". Re-running scan...`
5. Layne re-runs the scan; if coverage completes, the check run shows success with the exception audit trail. Ordinary incomplete coverage shows neutral, while high-risk Spectre file-cap overflow remains failure
6. If coverage completes, label `security-exception-used` is added to the PR; ordinary incomplete coverage uses incomplete labels and blocking coverage failure uses failure labels
7. Notification sent to Rocket.Chat/Slack
8. Developer pushes a new commit - if the commit does not touch the flagged line, the exception survives and no re-approval is needed; if the flagged line is modified, the exception is invalidated and Bob must re-approve
