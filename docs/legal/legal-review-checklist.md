# SARbase legal review checklist

Working checklist for the owner and qualified counsel. Every item is
labeled: **[FACT]** verified from the codebase · **[DRAFT]** proposed
contractual language · **[ASSUMPTION]** reasonable but unverified ·
**[OWNER]** owner decision required · **[COUNSEL]** needs qualified
legal advice.

## 1. Operator identity

- **[OWNER]** Legal name of the person or entity operating SARbase —
  fills `[OPERATOR LEGAL ENTITY]` in the Privacy Policy and Terms.
- **[OWNER]** Registered address / principal place of business.
- **[OWNER]** Contact emails for privacy requests and legal notices —
  fills `[PRIVACY CONTACT]`.
- **[COUNSEL]** Is a formal business entity needed/advisable before
  serving organizations (liability shielding, contracting capacity,
  local registration duties on Saba)?

## 2. Governing law & jurisdiction

- **[OWNER+COUNSEL]** Choose governing law for the Terms —
  `[GOVERNING LAW]` placeholder. Candidates: Caribbean Netherlands /
  Bonaire, Sint Eustatius and Saba law; Dutch law; the operator's
  jurisdiction.
- **[COUNSEL]** Enforceability of online terms against volunteers who
  accept on behalf of an organization's account — are the individual
  users or only the organization bound? How should acceptance map to
  the contracting party?
- **[COUNSEL]** Whether a mandatory arbitration or venue clause is
  enforceable for the expected user base (non-consumers; volunteers).

## 3. Privacy law applicability

- **[FACT]** No analytics, tracking cookies, advertising, or
  behavioral profiling exist in the product.
- **[FACT]** Personal data stored includes names, contact details,
  emergency contacts (third parties), qualifications, availability,
  callout responses, incident participation, expenses, attachments,
  and sign-in/delivery timestamps.
- **[COUNSEL]** Confirm which privacy statute(s) apply: Caribbean
  Netherlands data-protection law for the pilot; whether GDPR applies
  extraterritorially (Art. 3(2)) for any expected processing; whether
  other jurisdictions attach when organizations outside BES onboard.
- **[COUNSEL]** Whether emergency-contact data requires a
  transparency notice to the third party, and who must deliver it
  (draft policy places this on the organization).
- **[COUNSEL]** Whether any processed category qualifies as
  sensitive/special-category data under the applicable statute
  (qualification evidence may include medical certificates — uploaded
  at member/organization discretion, not demanded by the platform).

## 4. Roles: controller / processor

- **[DRAFT]** Policy states: organization controls its workspace
  records; operator processes on its behalf, and acts independently
  for account/security data. Confirm this allocation with counsel.
- **[OWNER+COUNSEL]** Decide whether a Data Processing Addendum is
  needed per organization — draft at `organization-agreement.md`.
- **[COUNSEL]** Whether the operator needs a named representative in
  any jurisdiction.

## 5. Third-party processors

- **[FACT]** Processors: Google Firebase (auth), Neon (database),
  Vercel (hosting/logs), AWS S3+GuardDuty+EventBridge+SQS+CloudWatch
  (attachments when enabled), Resend (email when configured), Meta
  (WhatsApp when enabled + member consent), Sentry (error monitoring
  when enabled, scrubbed).
- **[OWNER]** Confirm each processor's own terms/DPA is accepted and
  on file (AWS, Google, Meta, Resend, Neon, Vercel, Sentry).
- **[COUNSEL]** International-transfer clauses needed for the
  applicable law (BES/EU model clauses or local equivalents).
- **[OWNER]** Record actual configured regions (Vercel, Neon, S3)
  once production settings are final — the policy deliberately makes
  no residency claim until then.

## 6. Terms substance

- **[DRAFT]** Sections drafted: service description, no emergency
  service, no operational authority, human responsibility,
  communication limits, accounts, acceptable use, IP/data ownership,
  availability, disclaimers, liability cap, indemnity,
  suspension/termination, governing law, changes, contact.
- **[COUNSEL]** Liability cap figure/mechanism — `[LIABILITY CAP]`
  placeholder (options: fees-paid-12-months, fixed sum, or per-claim
  tier). Non-excludable-liability carve-out is drafted; confirm it
  matches the chosen governing law.
- **[COUNSEL]** Indemnity scope — drafted narrowly (unlawful use,
  unauthorized data submissions, operational decisions). Confirm it
  is enforceable and sufficiently protective.
- **[COUNSEL]** Whether any provision could be attacked as
  unenforceable disclaimer in the target jurisdictions (e.g.,
  safety-critical use disclaimers).
- **[OWNER]** Post-termination data-export window —
  `[RETENTION WINDOW]` placeholder.

## 7. Acceptance & enforceability

- **[FACT]** Acceptance framework records: identity, terms version,
  privacy version, document content hash, timestamp, mechanism.
  Enforcement is gated behind `LEGAL_ACCEPTANCE_REQUIRED` — OFF
  while documents are drafts.
- **[COUNSEL]** Whether click-wrap acceptance ("I accept" checkbox +
  timestamped record) is enforceable for the user base, and whether
  the privacy notice needs separate acknowledgment or merely
  availability.
- **[COUNSEL]** Reacceptance on material change: current design
  requires a fresh acceptance row per version — confirm sufficiency.
- **[OWNER]** Decide the first approved `version` and `effectiveDate`
  after counsel sign-off (documents ship as `0.1-draft`).

## 8. Organization agreement

- **[DRAFT]** `organization-agreement.md` — responsibilities, user
  management, privacy, security, incident reporting, retention/export,
  termination, processors, operational decisions, liability. Review
  with counsel before offering it to organizations.
- **[OWNER]** Whether onboarding organizations must sign it in
  writing, accept in-app, or accept implicitly under the platform
  terms.
- **[COUNSEL]** Insurance: does the operator need
  professional-liability/cyber cover given the safety-adjacent use
  case? This is a business decision informed by counsel.

## 9. Retention & breach

- **[FACT]** No automatic deletion exists anywhere; audit tables are
  append-only by design; attachments soft-delete with preserved
  history; exports are audited.
- **[OWNER+COUNSEL]** Set a formal retention schedule per record
  class (members, incidents, attachments, notifications, audit logs,
  sessions) — policy currently states "retained while the
  relationship persists + legal/audit needs".
- **[COUNSEL]** Breach-notification obligations under applicable law
  — who must be notified, thresholds, timelines — and whether the
  organization or the operator carries the duty for workspace data.
- **[OWNER]** Incident-response ownership for a data breach — see
  `runbooks/production-incident-response.md` for the technical plan.

## 10. Outstanding questions for counsel (summary)

1. Entity structure and governing law/venue choices (§§1–2).
2. Which privacy statutes apply and to which data flows (§3).
3. Controller/processor split + whether per-org DPAs are required (§4).
4. Liability cap mechanism and indemnity enforceability (§6).
5. Click-wrap enforceability and privacy-acknowledgment mechanics (§7).
6. Whether organizations sign the agreement, and insurance needs (§8).
7. Retention schedule and breach-notification duties (§9).

## What remains before public use (gate)

- [ ] Operator identity, address, and contact details supplied.
- [ ] Governing law and venue selected.
- [ ] Counsel review of Terms, Privacy Policy, organization agreement.
- [ ] Documents marked `approved` with effective dates in
      `src/lib/legal/documents.ts`.
- [ ] `LEGAL_ACCEPTANCE_REQUIRED` enabled only after approval.
- [ ] Organization agreement signed/accepted by participating orgs.
- [ ] Retention schedule adopted and reflected in the policy.
