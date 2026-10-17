# SARbase privacy & legal exposure inventory

**Status:** factual technical inventory, verified against the codebase
(commit range through `f673e12`). This document states what the system
actually does — it is the evidence base for the Privacy Policy, Terms of
Service, and legal-review checklist. Where something could not be
verified from the repository it is marked **[unverified]** rather than
assumed.

## Parties (drafted model — Phase 2)

| Role                           | Entity                                   | Notes                                                                                                                                                                                         |
| ------------------------------ | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Platform operator              | **[OWNER DECISION]**                     | Person or legal entity operating the SARbase deployment: hosting, code, infrastructure admin. Identity, address, and contact details are unresolved placeholders throughout the legal drafts. |
| Participating SAR organization | e.g. Saba SAR                            | Controls its own members, records, callouts, incidents, and operational decisions.                                                                                                            |
| Individual user                | Volunteers, coordinators, administrators | Authenticated people with an `AuthIdentity`; may hold member records and/or access grants in one or more organizations.                                                                       |

## Personal data actually stored

| Category               | Records (schema)                                                                                                            | Contents                                                                                                                                                 |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Account/authentication | `AuthIdentity`                                                                                                              | Firebase UID (`providerUid`), sign-in email (normalized, non-unique), status, `lastSignInAt`, created/updated timestamps.                                |
| Organization access    | `OrganizationAccess`, `OrganizationAccessEvent`                                                                             | Role/capability grants per identity per org; append-only grant/revoke history.                                                                           |
| Member profiles        | `Member`, `MemberUnit`, `MemberContactChange`                                                                               | displayName, optional email/phone, **emergency contact name + phone**, status, unit assignments; audited contact-field history (self-reported vs admin). |
| Invitations            | `MemberInvitation`, `MemberInvitationEvent`                                                                                 | destination email snapshot, role, token **hash** (never raw token), status, expiry, send/accept/revoke events with actor ids.                            |
| Qualifications         | `QualificationDefinition`, `MemberQualification`, `MemberSubmission`                                                        | claimed/verified records: issuer, reference numbers, issue/expiry dates, notes, attachments; member self-submissions with review trail.                  |
| Training               | `TrainingEvent`, `TrainingAttendance` (+ changes)                                                                           | attendance facts, corrections history.                                                                                                                   |
| Availability           | `MemberAvailabilityUpdate`                                                                                                  | append-only self-declared availability with timestamps and actor.                                                                                        |
| Communications         | `Notification`, `NotificationAttempt`, `NotificationDeliveryEvent`, `MemberNotificationPreference`                          | dispatch-time body **snapshots**, provider message ids, delivery status, channel preferences, **WhatsApp consent timestamps + opt-out**.                 |
| Callouts/incidents     | `Callout`, `CalloutInvitation`, `CalloutResponseChange`, `Incident*`                                                        | who was invited, who responded how, incident participants, notes, timeline, append-only field corrections (`CalloutChange`, `IncidentChange`).           |
| Equipment/finance      | Assets, inspections, maintenance, defects, meters, vendors, `Expense*`                                                      | org operational records; expenses may reference members.                                                                                                 |
| Attachments            | `Attachment`, `AttachmentEvent`, `AttachmentScanEvent`, link tables                                                         | S3 object references, upload/scan/download/delete events with actor ids, malware-scan verdicts.                                                          |
| Audit/operations       | `DataExportEvent`, `RateLimitWindow`, `MemberInvitationEvent`, `OrganizationAccessEvent`, `CalloutChange`, `IncidentChange` | who exported what dataset when; hashed rate-limit keys (**no IPs/PII by design**); lifecycle events.                                                     |
| Technical              | Vercel platform logs; Sentry (only if `SENTRY_DSN` set)                                                                     | HTTP logs handled by hosting provider; Sentry events pass through the repo's scrubbing layer before send.                                                |

### Sensitive-by-context data (flagged for counsel)

- **Emergency contacts** (name + phone of third parties who never
  consented to SARbase).
- **Qualification/medical-adjacent evidence** — certificate attachments
  can carry anything a member uploads.
- **Availability statements** — a de-facto movement/lifestyle signal.
- **Incident records** — may describe real emergencies and people.
- **Notification delivery events + lastSignInAt** — behavioral
  timestamps.

## Processors receiving data (verified from code/env)

| Processor                               | Data sent                                                                  | When active                                                       |
| --------------------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Google Firebase Auth                    | email, password credentials, UID, token verification                       | Always (authentication).                                          |
| Neon (Postgres)                         | all application data                                                       | Always (primary datastore).                                       |
| Vercel                                  | app hosting, HTTP/server logs, env vars                                    | Always (deployment).                                              |
| AWS S3                                  | attachment object bytes + metadata                                         | When `FILE_STORAGE_PROVIDER=s3`.                                  |
| AWS GuardDuty                           | S3 object scanning                                                         | Same scope as S3.                                                 |
| AWS EventBridge/API Dest/SQS/CloudWatch | scan-event payloads (object keys, verdicts) to the app webhook             | Same scope.                                                       |
| Resend                                  | notification email content + recipient address                             | When `RESEND_API_KEY` set.                                        |
| Meta WhatsApp Business                  | template message content, member phone number, delivery/read status events | When `WHATSAPP_PROVIDER` configured **and** the member consented. |
| Sentry                                  | scrubbed error telemetry                                                   | Only when `SENTRY_DSN` set.                                       |

**No analytics, advertising, or tracking technology exists.** Cookies:
one HttpOnly session cookie (`sarbase_session`, 5-day max age,
SameSite=Lax, revocation-checked) — strictly necessary. `localStorage`
holds theme and sidebar-pin UI preferences only (never transmitted).

## Authentication & authorization

- Firebase email/password; ID token verified server-side via Admin SDK;
  session cookie revocation-checked every request.
- Identity auto-provisioned with **zero** access on first sign-in; org
  access comes only from explicit grants or invitation acceptance.
- Capabilities are server-enforced; disabled identities fail closed.
- **No public self-registration.**

## Isolation & security

- Every org-scoped query filters by server-derived `organizationId`;
  composite foreign keys make cross-org references impossible at the DB
  level.
- Attachments are fail-closed until a GuardDuty CLEAN verdict + object
  tag agree; downloads are server-authorized.
- Rate limiting uses hashed keys only — no PII in limiter storage.

## Retention & deletion (honest statement)

- **Nothing purges automatically.** No TTL, no scheduled deletion.
- Member `status` toggles ACTIVE/INACTIVE — records are never
  destructively deleted from the app surface (FKs `Restrict` history).
- `AuthIdentity` can be DISABLED; member↔identity unlink uses SetNull —
  history keeps the scalar reference by design.
- Attachments soft-delete (`DELETED` status + storage delete +
  preserved event history).
- Audit/change/event tables are append-only with no retention policy.
- **Consequence:** the Privacy Policy must promise "retained while the
  relationship persists + as needed for legal/operational audit" —
  not a fixed schedule. A formal retention schedule is an open legal
  decision (see checklist).

## Individual rights mechanisms (existing)

| Right      | Mechanism today                                                                                                           |
| ---------- | ------------------------------------------------------------------------------------------------------------------------- |
| Access     | Members view their own dashboard, availability, qualifications, training history, submissions.                            |
| Correction | Self-service contact edits (audited); correction submissions (reviewed by org staff).                                     |
| Consent    | WhatsApp consent is self-service only; opt-out via STOP or preference toggle — admins cannot grant it.                    |
| Export     | Org-scoped CSV export datasets (52 keys) gated by `REPORTS_EXPORT`; exports themselves audited (`DataExportEvent`).       |
| Deletion   | **None self-service.** Deactivation/unlink are administrative; account deletion would need a process (open gap, Phase 9). |

## Open gaps for governance review (Phase 9)

1. No user-facing account-deletion request flow.
2. No formal retention schedule for any table.
3. Emergency-contact third parties have no notice mechanism (the
   organization's member is the only channel).
4. No DPA/subprocessor list surfaced to organizations in-app.
5. Terms acceptance framework does not yet exist (PR C scope).

## Jurisdiction notes (Phase 2 findings — for counsel)

- Deployment/operator location: **[unverified — owner decision]**. The
  pilot organization is on **Saba (Caribbean Netherlands)**.
- Caribbean Netherlands has its own data-protection statute (Wbp BES
  lineage); **EU GDPR does not automatically apply** to BES entities.
  GDPR may still apply extraterritorially (Art. 3(2)) if processing
  targets or monitors people in the EU/EEA, or via participating
  organizations established in the EU.
- All processor regions are deployment-configured, not verified: Vercel
  region, Neon region, S3 region are environment decisions; Firebase,
  Meta, Resend process on their global infrastructure. The policy must
  not claim data stays in any particular jurisdiction.
