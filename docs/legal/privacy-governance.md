# Privacy rights & data governance audit

**Status:** technical audit, verified against the codebase on 2026-10-17.
Pairs with [`inventory.md`](./inventory.md) (what data exists) and
[`legal-review-checklist.md`](./legal-review-checklist.md) (owner/legal
decisions). Entries marked **[issue]** have a filed follow-up; entries
marked **[owner]** require an owner or legal decision, not code.

---

## 1. What exists today (verified)

| Right / control                  | Mechanism                                                                                                                                                                                                                         | Where                                                                                         |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Member sees own records          | `/account` lists the caller's own linked Member rows **only where an OrganizationAccess row also exists** — a Member link alone exposes nothing                                                                                   | `src/app/account/page.tsx` (`linkedMembersWithAccess`)                                        |
| Own qualifications & training    | Same `/account` surface, per linked member per org                                                                                                                                                                                | `listMemberQualifications`, `listMemberTraining`                                              |
| Own availability & contact prefs | Self-service read/write, per (member, org) block; history shown                                                                                                                                                                   | `getMemberAvailability`, `getMemberContactPreference`                                         |
| Correction                       | (a) member submissions flow — member files a change, org staff review/approve; (b) org staff edit member records directly under capability; (c) self-service availability/contact prefs                                           | `reviewMemberSubmissionAction`, member update actions                                         |
| Emergency contact                | Member-editable field on the Member record (issue #71), same submission/audit path as email/phone                                                                                                                                 | `Member.emergencyContactName/Phone`, `MemberSubmission`                                       |
| Account deactivation             | `AuthIdentity.status = DISABLED` blocks all access at `getAuthContext`; `MemberStatus` INACTIVE is a separate domain state                                                                                                        | `src/lib/auth/context.ts`                                                                     |
| Identity unlink                  | Administrator-only action; Member record persists, account linkage removed                                                                                                                                                        | `unlinkIdentityFromMemberAction`                                                              |
| Organization data export         | 42 datasets covering every domain table **including audit events** (invitation events, incident changes, expense changes, export events); gated on `REPORTS_EXPORT`, org-scoped server-side, unknown datasets collapse to 404     | `src/app/api/organizations/[orgId]/exports/[dataset]/route.ts`, `src/lib/exports/datasets.ts` |
| Attachment handling              | Private S3; download blocked until verified GuardDuty scan clears; abandoned `staging/` uploads expire via bucket lifecycle; orphan cleanup on failed finalization                                                                | `docs/attachments.md`, `src/lib/domain/attachments.ts`                                        |
| WhatsApp consent                 | Explicit opt-in (`whatsappConsentAt` + recording identity) separate from notification preference; dispatch requires both — preference alone can never manufacture consent; opt-out is auditable                                   | `Member` consent fields, `docs/notifications.md`                                              |
| Org isolation                    | All domain queries org-scoped server-side; tenant scope resolved from the target record, never client input                                                                                                                       | `src/lib/auth/authorize.ts`, permission-matrix tests                                          |
| Audit trail                      | Per-domain event models (callout changes, incident changes/notes corrections, invitation events, expense changes, export events) — append-only, all exportable                                                                    | `prisma/schema.prisma`, `EXPORT_DATASETS`                                                     |
| Terms acceptance                 | Append-only `TermsAcceptance` rows: identity, terms version + content hash, privacy version + hash presented, mechanism, timestamp. Idempotent per (identity, version). Enforcement doubly gated (owner flag + approved document) | `src/lib/legal/acceptance.ts`, migration `20261017130142`                                     |
| Sign-in tracking                 | `AuthIdentity.lastSignInAt` — timestamp only, written solely after a verified sign-in; no IP/device/user-agent stored                                                                                                             | migration `20261017122617`                                                                    |

## 2. Gaps and dispositions

| #   | Gap                                                                                                                                                                                                         | Severity             | Disposition                                                                                                                                                                                                                  |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1  | **No retention policy exists anywhere.** All records — members, incidents, attachments, audit events, invitations, TermsAcceptance — are retained indefinitely.                                             | Legal/owner decision | **[owner]** Retention schedule belongs in the Privacy Policy + org agreement; counsel input required on operational-record vs personal-data retention. Code enforcement should follow the decision, not precede it.          |
| G2  | **No deletion path for domain records.** Members, incidents, qualifications, notes are never deleted — by design today, but "right to erasure" requests have no answer beyond org-level record retention.   | High                 | **#135** Needs a designed workflow: what may be erased (contact details, emergency contact), what must survive (incident history, audit), and how unlink + erasure interact. Not safe to improvise.                          |
| G3  | **No account (AuthIdentity) deletion flow.** Identity DISABLE exists; erasure does not. TermsAcceptance deliberately stores a plain `authIdentityId` so acceptance history survives identity deletion.      | High                 | **#135** Pair with G2 — one coherent "individual leaves" design covering identity, member link, acceptance evidence, and org records.                                                                                        |
| G4  | **No individual (cross-org) data export.** Org admins can export 42 datasets, but an individual cannot self-serve "all data held about me" across orgs + identity + acceptances.                            | Medium               | **#136** A "download my data" on `/account` is feasible: the account surface already resolves the person's linked members + access; export of their own rows + TermsAcceptance + identity facts is a bounded feature.        |
| G5  | **TermsAcceptance has no read surface.** Records exist and are tamper-evident via hash, but neither the user nor an authorized admin can view acceptance history.                                           | Low                  | **#137** Small: show the user's own acceptance history on `/account` (self-verification); platform-level admin review can wait for an ops console. Org admins must NOT see it — acceptance is person↔operator, not org data. |
| G6  | **No breach-notification runbook.** `runbooks/production-incident-response.md` covers technical response; personal-data breach notification duties (who notifies whom, in what timeframe) are undocumented. | Medium               | **[owner]** Legal decision: which breach-notification regime applies (see checklist Q on applicable law). Then document in the incident runbook.                                                                             |
| G7  | **Invitation tokens carry PII-adjacent state.** Invitation emails reveal a member's email to the invitee — expected — but expired/revoked invitation rows retain the destination address indefinitely.      | Low                  | Covered by G1 retention decision; noting so it isn't lost.                                                                                                                                                                   |
| G8  | **Processor/sub-processor list is documentation-only.** Inventory lists Firebase, Neon, Vercel, AWS, Resend, Meta — no mechanism keeps it in sync with reality.                                             | Low                  | **[owner]** Maintain manually as part of the legal checklist; acceptable at current scale.                                                                                                                                   |

## 3. Security & compliance verification (Phase 10)

Evidence base — all in-tree, all green on this branch:

- **AuthN/Z**: Firebase ID-token verification → session cookie → `AuthIdentity` by `(provider, providerUid)`; disabled identities rejected at `getAuthContext`. No linking by email anywhere. Covered by `src/app/login/actions.test.ts` + authz db tests.
- **Org isolation**: `permission-matrix.test.ts` proves every admin action and page names its guard; tenant scope always resolves from the target record.
- **Export permission**: `REPORTS_EXPORT` gate + opaque 404s in `route.test.ts` / `exports.db.test.ts`.
- **Sensitive member data**: account/invitation details on the member detail page are Administrator-only; `MEMBERS_MANAGE` managers see none of it (issue #84).
- **Consent**: WhatsApp dispatch requires explicit consent + preference; consent events auditable.
- **Attachments**: scan-gated downloads, private bucket, fail-closed webhook (`unset → 503`).
- **Legal pages & acceptance**: `/privacy`,`/terms` public, no tracking added; `/legal/accept` authenticated-only (smoke test); action rejects forged checkbox values and external `next` targets (unit tests); acceptance records immutable by construction (no update/delete paths).
- **No new bypass**: the acceptance gate sits inside `requireAuth` — the same chokepoint everything else uses; opt-outs are explicit and minimal (`/legal/accept`, `/account`).

**Residual risk:**

- `requireTermsAcceptance` redirects inside `requireAuth` also fire for server actions — a redirect response to an action caller is unusual but safe (the action never executes). Only relevant once enforcement is enabled.
- Acceptance enforcement is **untestable end-to-end** until a document is approved — by design. The dual gate is unit-tested; the enabled path should get a browser pass before the flag is flipped in production.
- `TermsAcceptance.authIdentityId` is a plain string (deliberate — audit survives identity deletion). Orphan rows are possible by construction; they're forensic references, not live data.

## 4. Recommended activation order

1. Owner/legal: answer the controller/processor and applicable-law questions in `legal-review-checklist.md`.
2. Owner/legal: decide the retention schedule (G1) — it gates G2/G3 design.
3. Legal review of the drafted documents; flip `status: "approved"` in `documents.ts` (one-line change per document).
4. Deploy; set `LEGAL_ACCEPTANCE_REQUIRED=true` — existing users are gated at next sign-in, new users at first use. `/account` stays reachable for data access regardless.
5. Build G4 self-serve export before or alongside enforcement — "accept our terms" lands better when users can already retrieve their data.
6. Design G2+G3 deletion as one workflow; implement behind admin-only paths.
