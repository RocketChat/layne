---
"layne": major
---

Skip draft pull requests by default across direct and deferred triggers, and handle ready_for_review events. Set trigger.scanOnDraft to true globally or per repository to preserve scanning drafts. Deferred CI workflows should subscribe to ready_for_review.
