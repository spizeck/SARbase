# SARbase legal documentation

This directory contains the legal and governance working set.

| File                                                   | Role                                                                                                                              |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| [inventory.md](inventory.md)                           | Verified technical inventory — what SARbase actually collects, stores, sends, and retains. The evidence base for everything else. |
| [legal-review-checklist.md](legal-review-checklist.md) | Checklist of owner/legal decisions, separating verified facts from assumptions and open questions.                                |
| [organization-agreement.md](organization-agreement.md) | DRAFT organization agreement / data-processing addendum for counsel review. Not activated.                                        |

**Canonical document text** for the Privacy Policy and Terms of
Service lives in [`src/lib/legal/documents.ts`](../../src/lib/legal/documents.ts) —
it is what the public `/privacy` and `/terms` pages render and what
the terms-acceptance records hash. Read it directly for legal review;
the `version` stamps there are the version of record. Both documents
are marked `draft` and must not be enforced until approved.
