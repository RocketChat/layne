# Exception Approvals

Layne can be configured to allow specific users or teams to approve individual findings that would otherwise block a PR. This is useful for accepted risks, false positives, or hotfixes that need to merge quickly.

Exceptions are **deliberate and auditable** - the approver must reference the exact finding ID(s) and provide a written reason. This is intentionally stricter than a generic PR approval.

## How It Works

1. Layne runs a scan and finds blocking findings (critical/high severity)
2. The check run fails with `conclusion: failure`
3. The check run summary lists each blocking finding with its ID and a ready-to-copy command
4. An authorized approver posts a PR comment with the command:
   ```
   /layne exception-approve LAYNE-a3f29c81b7e41d22 reason: test credential, will be rotated before release
   ```
5. Layne receives the `issue_comment` webhook, validates the command and the approver's authorization
6. Layne stores the exception in Redis (scoped to the PR) and re-runs the scan
7. The check run passes with `conclusion: success` and a summary listing who excepted each finding and why

Exceptions survive new commits as long as the flagged line has not changed. If the flagged line is modified by a subsequent commit, the exception is invalidated and a new approval is required. Unrelated commits - rebases, merge commits from the base branch, changes to other files - do not affect existing approvals.

## The Command

Post a comment on the PR containing the following on a single line:

```
/layne exception-approve <ID> [<ID> ...] reason: <explanation>
```

| Part | Description |
|---|---|
| `/layne exception-approve` | Required trigger prefix |
| `<ID>` | One or more finding IDs in `LAYNE-xxxxxxxxxxxxxxxx` format (from the check run summary) |
| `reason: <explanation>` | Required - free-text explanation; recorded in the audit trail |

**Multiple findings in one command:**
```
/layne exception-approve LAYNE-a3f29c81b7e41d22 LAYNE-b7e41d22a3f29c81 reason: legacy code, tracked in JIRA-1234
```

The command can appear anywhere in the comment body - other text before or after it is ignored.

## Finding IDs

Each finding gets a deterministic `LAYNE-xxxxxxxxxxxxxxxx` ID derived from the tool, file, and line number. The same finding produces the same ID on every scan as long as it remains at the same location, so the ID in the check run summary is stable until the flagged line moves or is removed.

## Check Run Summary

When exception approvers are configured, the check run summary includes the finding IDs and a copy-paste command.

**On failure (no exceptions yet):**
```
Found 2 issue(s): 0 critical, 2 high, 0 medium, 0 low.

Blocking findings:
- LAYNE-a3f29c81b7e41d22 [trufflehog/aws-key] src/config.js:42
- LAYNE-b7e41d22a3f29c81 [semgrep/eval] src/api.js:88

To approve, post a comment:
/layne exception-approve LAYNE-a3f29c81b7e41d22 LAYNE-b7e41d22a3f29c81 reason: <explanation>
```

**On failure (partial exceptions):**
```
Found 2 issue(s): 0 critical, 2 high, 0 medium, 0 low.

Blocking findings (1 remaining):
- LAYNE-b7e41d22a3f29c81 [semgrep/eval] src/api.js:88

Already excepted (1):
- LAYNE-a3f29c81b7e41d22 - excepted by @alice: "test credential"

To approve remaining findings, post:
/layne exception-approve LAYNE-b7e41d22a3f29c81 reason: <explanation>
```

**On success (all excepted):**
```
⚠️ Scan passed with excepted findings.

Found 2 issue(s): 0 critical, 2 high, 0 medium, 0 low.

Excepted findings:
- LAYNE-a3f29c81b7e41d22 [trufflehog/aws-key] src/config.js:42 - excepted by @alice: "test credential, will be rotated"
- LAYNE-b7e41d22a3f29c81 [semgrep/eval] src/api.js:88 - excepted by @bob: "legacy code, tracked in JIRA-1234"

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

When an exception is used, Layne can automatically add or remove labels on the PR:

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

## Notifications

Notifications are **always sent** when an exception is used - even if the finding count didn't increase. This ensures visibility for the security team regardless of prior notification state.

## Security Considerations

| Concern | Mitigation |
|---|---|
| Compromised approver account | Require 2FA on GitHub; follow org security policies |
| Team membership escalation | Audit team membership regularly; use CODEOWNERS |
| Config tampering | Protect `config/layne.json` with CODEOWNERS and branch protection |
| Approval for changed code | Exceptions are invalidated when the flagged line changes - only unrelated commits (rebases, merges from the base branch) preserve approvals |
| Silent approvals | Notifications always fire for exceptions; reason is required and recorded |
| Unauthorized command | Commands from non-approvers are silently ignored - no reply, no re-scan |

## Audit Trail

Every exception is recorded in:

1. **GitHub Check Run summary** - lists each excepted finding ID, who approved it, and the stated reason
2. **PR comment thread** - the approver's command and Layne's confirmation reply are visible to all reviewers
3. **PR label** - `security-exception-used` label (if configured)
4. **Chat notification** - sent to configured notifiers

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
/layne exception-approve LAYNE-a3f29c81b7e41d22 reason: accepted risk
             ↓
Layne validates command and authorization
             ↓
Exception stored in Redis (scoped to the PR)
Layne re-runs the scan
             ↓
All blocking findings excepted → PASS with audit note
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
2. Layne scan fails with `conclusion: failure`; summary shows `LAYNE-a3f29c81b7e41d22` and the copy-paste command
3. Bob (authorized user) posts:
   ```
   /layne exception-approve LAYNE-a3f29c81b7e41d22 reason: test credential, rotating before release
   ```
4. Layne replies: `✅ Exception recorded for LAYNE-a3f29c81b7e41d22 by @bob: "test credential, rotating before release". Re-running scan...`
5. Layne re-runs the scan; check run shows success with the exception audit trail
6. Label `security-exception-used` is added to the PR
7. Notification sent to Rocket.Chat/Slack
8. Developer pushes a new commit - if the commit does not touch the flagged line, the exception survives and no re-approval is needed; if the flagged line is modified, the exception is invalidated and Bob must re-approve
