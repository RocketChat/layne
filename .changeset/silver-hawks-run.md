---
"layne": patch
---

fix(server): confirmation comment only says "Re-running scan..." when a scan is actually queued

The issue_comment handler only re-enqueues a scan when the latest check
run conclusion is 'failure'. However the confirmation comment always
ended with "Re-running scan..." regardless of whether a scan was queued.
Users who approved an exception while the check run was in a success or
neutral state (or when no check run existed) saw a misleading message.
The suffix is now conditional on the scan actually being enqueued.
