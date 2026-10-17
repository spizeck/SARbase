import { createHash } from "node:crypto";

/**
 * Canonical legal document content for SARbase.
 *
 * SINGLE SOURCE OF TRUTH: the public /privacy and /terms pages render
 * this structure, and acceptance records (PR C) hash the serialized
 * text below — so the text here is the legal artifact. Review copies
 * for counsel live in docs/legal/ and must quote the same `version`.
 *
 * STATUS: every document here is `draft` until the owner marks it
 * `approved` after legal review. Draft documents are visible on the
 * public pages (clearly labeled) but MUST NOT be enforced — see
 * `LEGAL_ACCEPTANCE_REQUIRED` gating in PR C.
 *
 * Placeholders: [OPERATOR LEGAL ENTITY], [OPERATOR ADDRESS],
 * [PRIVACY CONTACT EMAIL], [GOVERNING LAW], [JURISDICTION VENUE] are
 * owner/legal decisions — never fill them in on someone's behalf.
 */

export type LegalDocStatus = "draft" | "approved";

export interface LegalDocBlock {
  readonly type: "p" | "list";
  readonly text?: string;
  readonly items?: readonly string[];
}

export interface LegalDocSection {
  /** Stable anchor id for the table of contents. */
  readonly id: string;
  readonly heading: string;
  readonly blocks: readonly LegalDocBlock[];
}

export interface LegalDocument {
  readonly key: "privacy" | "terms";
  readonly title: string;
  /** Version stamp — bump on every material change; recorded on acceptance. */
  readonly version: string;
  readonly status: LegalDocStatus;
  /** ISO date once approved; null while draft/unapproved. */
  readonly effectiveDate: string | null;
  readonly sections: readonly LegalDocSection[];
}

const P = (text: string): LegalDocBlock => ({ type: "p", text });
const L = (items: readonly string[]): LegalDocBlock => ({
  type: "list",
  items,
});

/**
 * The SAR operational disclaimer — deliberately short and factual.
 * Used inside Terms of Service and referenced from callout
 * documentation and organization onboarding guidance.
 */
export const SAR_DISCLAIMER =
  "SARbase is a management and communications tool. It does not replace " +
  "established emergency communication systems, qualified operational " +
  "judgment, or your organization's command procedures.";

/** Unresolved owner/legal placeholders — displayed verbatim until set. */
export const OPERATOR_PLACEHOLDER =
  "[OPERATOR LEGAL ENTITY — to be confirmed by the platform operator]";
export const PRIVACY_CONTACT_PLACEHOLDER =
  "[PRIVACY CONTACT — to be confirmed before publication]";

/**
 * Deterministic content fingerprint recorded on terms acceptance.
 * Covers the rendered prose, not code formatting — two documents with
 * identical visible text hash identically.
 */
export function legalDocumentHash(doc: LegalDocument): string {
  const hash = createHash("sha256");
  hash.update(doc.key);
  hash.update("|");
  hash.update(doc.version);
  for (const section of doc.sections) {
    hash.update("|");
    hash.update(section.heading);
    for (const block of section.blocks) {
      hash.update("|");
      hash.update(
        block.type === "p"
          ? (block.text ?? "")
          : (block.items ?? []).join("\n"),
      );
    }
  }
  return hash.digest("hex");
}

/* ---------------------------------------------------------------- */
/* Privacy Policy — DRAFT for legal review                            */
/* ---------------------------------------------------------------- */

export const PRIVACY_POLICY: LegalDocument = {
  key: "privacy",
  title: "SARbase Privacy Policy",
  version: "0.1-draft",
  status: "draft",
  effectiveDate: null,
  sections: [
    {
      id: "status",
      heading: "Document status",
      blocks: [
        P(
          "This document is a DRAFT under legal review. It has not been " +
            "approved or adopted by the platform operator. It is published " +
            "here for transparency and review only and does not yet " +
            "constitute the operator's official privacy notice.",
        ),
      ],
    },
    {
      id: "who-we-are",
      heading: "1. Who operates SARbase",
      blocks: [
        P(
          `SARbase is operated by ${OPERATOR_PLACEHOLDER} ("the operator", ` +
            '"we", "us"). SARbase is a software platform used by ' +
            "independent search-and-rescue organizations to manage their " +
            "volunteers, equipment, communications, and operational records.",
        ),
        P(
          "Each participating organization decides who its volunteers are, " +
            "what records it keeps about them, and how it runs its " +
            "operations. For records inside an organization's workspace, " +
            "that organization is responsible for the data it chooses to " +
            'store (the "data controller" under laws that use that term). ' +
            "The operator provides and maintains the platform on the " +
            'organization\'s behalf (a "data processor" or service ' +
            "provider role), except for the account-level and platform " +
            "security data described below, where the operator acts " +
            "independently.",
        ),
      ],
    },
    {
      id: "information-we-collect",
      heading: "2. Information we process",
      blocks: [
        P(
          "SARbase processes the following categories of information, depending on which features your organization uses:",
        ),
        L([
          "Account and sign-in data — the email address you sign in with, a technical account identifier, account status, and the timestamp of your most recent verified sign-in.",
          "Member profile data — your name, optional contact email and phone number, membership status, and unit assignments, as recorded by your organization.",
          "Emergency contact data — the name and phone number of an emergency contact you or your organization records. This data concerns a third party; your organization is responsible for telling that person their details are stored.",
          "Availability statements — availability statuses and dates you or an authorized person records.",
          "Qualifications and training — qualification records, issuers, reference numbers, issue and expiry dates, attached certificates, training attendance, and corrections you submit.",
          "Callout and response data — which members were invited to a callout, delivery status of notifications, and your explicit responses.",
          "Incident records — participants, assets, notes, and timeline entries your organization records.",
          "Communication preferences — your notification channel preferences and, where you choose it, WhatsApp consent records and opt-outs.",
          "Attachments — files uploaded to organization records, retained while the record exists, and scanned for malware before download is allowed.",
          "Financial records — expenses your organization records, which may reference you as submitter or payer.",
          "Usage and audit records — who created or changed records, who was granted or denied access, data exports performed, and invitation and acceptance events.",
          "Technical logs — hosting and error-monitoring logs, minimized and scrubbed where the platform controls them.",
        ]),
      ],
    },
    {
      id: "what-we-do-not-collect",
      heading: "3. What we do not collect",
      blocks: [
        L([
          "No advertising identifiers, analytics beacons, or behavioral tracking.",
          "No tracking cookies. The only cookie is a strictly necessary sign-in session cookie; interface preferences are stored locally in your browser and never transmitted.",
          "No payment card or banking details.",
          "No location tracking or GPS collection.",
        ]),
      ],
    },
    {
      id: "purposes-and-legal-bases",
      heading: "4. Why we process this information",
      blocks: [
        P(
          "Depending on the law that applies to you (see section 10), we rely on the following grounds:",
        ),
        L([
          "To operate the service your organization contracted for — member records, callouts, incidents, qualifications, and communications (performance of a contract or the equivalent ground under applicable law).",
          "With your consent — where the law requires it for optional features, most importantly WhatsApp messaging, which is sent only after you personally opt in and can be withdrawn at any time.",
          "Legitimate interests — platform security, abuse prevention, rate limiting, audit trails, and service integrity, balanced against your rights.",
          "Legal obligations — preserving records where law or regulatory duties require.",
        ]),
      ],
    },
    {
      id: "communications",
      heading: "5. Email and WhatsApp notifications",
      blocks: [
        P(
          "Email notifications are sent through our email processor to the address your organization recorded. WhatsApp messages are sent only " +
            "after you personally grant consent inside SARbase — administrators cannot consent on your behalf. You may withdraw WhatsApp consent " +
            "at any time from your notification preferences or by replying STOP; the withdrawal is recorded and honored across organizations.",
        ),
        P(
          "Delivery status events (sent, delivered, read, failed) are recorded so coordinators can see whether a notification was transmitted. " +
            "Delivery status is a provider report — it is never represented as a volunteer's response or willingness to attend.",
        ),
      ],
    },
    {
      id: "processors",
      heading: "6. Who processes data on our behalf",
      blocks: [
        P(
          "SARbase uses the following categories of subprocessors. The exact list your deployment uses may depend on enabled features:",
        ),
        L([
          "Authentication — Google Firebase Authentication (sign-in credentials and identity).",
          "Database hosting — Neon (PostgreSQL).",
          "Application hosting and logs — Vercel.",
          "File storage and malware scanning — Amazon Web Services (S3, GuardDuty, EventBridge, SQS, CloudWatch), active only when attachments are enabled.",
          "Transactional email — Resend, active only when email is configured.",
          "WhatsApp messaging — Meta Platforms, active only when the WhatsApp channel is enabled and the member has consented.",
          "Error monitoring — Sentry, only when enabled for the deployment; error data is scrubbed before transmission.",
        ]),
        P(
          "Each processor receives only the data its function requires. We do not sell personal information or share it for advertising.",
        ),
      ],
    },
    {
      id: "international-transfers",
      heading: "7. Where data is processed",
      blocks: [
        P(
          "SARbase and its processors operate infrastructure in multiple jurisdictions. We do not promise that your data remains in the " +
            "Caribbean Netherlands, the European Union, or any other specific region. Where law requires transfer safeguards, the relevant " +
            "processor's contractual protections apply; organizations may ask the operator which regions are configured for their deployment.",
        ),
      ],
    },
    {
      id: "retention",
      heading: "8. How long we keep data",
      blocks: [
        P(
          "SARbase keeps organization records for as long as the organization maintains them — there is no automatic deletion. " +
            "Audit, change, and event history (who did what and when) is preserved by design for operational and legal accountability, and may " +
            "outlive the records it describes where justified or legally required.",
        ),
        P(
          "Attachments removed from records are deleted from file storage while their history is kept. Deactivated members and disabled " +
            "accounts stop being usable, but their historical records are preserved. A formal retention schedule is under legal review and " +
            "will be published here once adopted.",
        ),
      ],
    },
    {
      id: "security",
      heading: "9. How we protect data",
      blocks: [
        L([
          "Each organization's data is isolated and accessible only to that organization's authorized users; isolation is enforced at both application and database level.",
          "Sign-in uses Firebase Authentication with server-verified, revocable sessions; accounts can be disabled immediately.",
          "Capabilities are checked on the server for every privileged action.",
          "Attachments are scanned for malware and cannot be downloaded until a clean scan verdict is recorded.",
          "Access grants, sensitive record changes, exports, and account events are audit-logged.",
          "Secrets and credentials are stored in hosting-provider secret storage, never in source code.",
        ]),
        P(
          "No system is perfectly secure; these measures are described factually, not as a guarantee.",
        ),
      ],
    },
    {
      id: "your-rights",
      heading: "10. Your rights and choices",
      blocks: [
        P(
          "Depending on the law that applies to you — which may include the data-protection law of the Caribbean Netherlands or, where it applies " +
            "extraterritorially, the EU/EEA GDPR — you may have rights to access, correct, export, restrict, or delete your personal data, and to " +
            "withdraw consent.",
        ),
        P("In practice:"),
        L([
          "You can view and correct your own contact details, availability, and communication preferences from your account.",
          "You can submit corrections to qualification and training records for your organization to review.",
          "You can withdraw WhatsApp consent at any time.",
          "For access, export, or deletion requests beyond self-service, contact your organization first — it controls the records in its workspace. You can also contact the operator (section 12).",
          "Some records cannot be deleted where legal or operational duties require their preservation; where that applies, we will explain why rather than delete silently.",
        ]),
      ],
    },
    {
      id: "children",
      heading: "11. Children's information",
      blocks: [
        P(
          "SARbase is an administrative platform for SAR organizations and is not directed at children. Organizations that enroll junior or " +
            "cadet volunteers are responsible for any parental-consent or age-related duties under their own law.",
        ),
      ],
    },
    {
      id: "contact-and-changes",
      heading: "12. Contact and changes to this policy",
      blocks: [
        P(`Privacy questions and requests: ${PRIVACY_CONTACT_PLACEHOLDER}.`),
        P(
          "If we materially change this policy we will update the version and date above and, for significant changes, provide notice inside " +
            "the application or by email where practicable.",
        ),
      ],
    },
  ],
};

/* ---------------------------------------------------------------- */
/* Terms of Service — DRAFT for legal review                          */
/* ---------------------------------------------------------------- */

export const TERMS_OF_SERVICE: LegalDocument = {
  key: "terms",
  title: "SARbase Terms of Service",
  version: "0.1-draft",
  status: "draft",
  effectiveDate: null,
  sections: [
    {
      id: "status",
      heading: "Document status",
      blocks: [
        P(
          "This document is a DRAFT under legal review. It has not been " +
            "approved or adopted by the platform operator. It is published " +
            "here for transparency and review only and is not yet binding " +
            "terms of service.",
        ),
      ],
    },
    {
      id: "about",
      heading: "1. About SARbase and these terms",
      blocks: [
        P(
          `These Terms of Service ("Terms") govern use of the SARbase ` +
            `platform operated by ${OPERATOR_PLACEHOLDER} ("the operator"). ` +
            "They apply to individual users — volunteers, coordinators, and " +
            "administrators — whose organizations use SARbase. The " +
            "relationship between the operator and each participating " +
            "organization may also be governed by a separate organization " +
            "agreement; where they conflict, the organization agreement " +
            "controls for the organization.",
        ),
      ],
    },
    {
      id: "the-service",
      heading: "2. The service",
      blocks: [
        P(
          "SARbase is an administrative, recordkeeping, communication, and " +
            "operational-support software platform for search-and-rescue " +
            "organizations. It records members, qualifications, training, " +
            "equipment, maintenance, callouts, responses, incidents, " +
            "documents, and related history, and it sends notifications by " +
            "email and, where enabled, WhatsApp.",
        ),
      ],
    },
    {
      id: "no-emergency-service",
      heading: "3. Not an emergency service",
      blocks: [
        P(
          "SARbase does not provide rescue services, emergency dispatch, " +
            "medical advice, or a replacement for established emergency " +
            "communication systems. In an emergency, contact your local " +
            "emergency services directly. Nothing in SARbase guarantees " +
            "that any alert will be received, delivered, or acted upon.",
        ),
        P(`"${SAR_DISCLAIMER}"`),
      ],
    },
    {
      id: "no-authority",
      heading: "4. No operational authority or certification",
      blocks: [
        P(
          "SARbase records facts and organizes information; it makes no " +
            "operational judgments. The software does not authorize a " +
            "rescue, certify a person, declare equipment seaworthy, " +
            "confirm that a crew is sufficient or ready, or determine " +
            "whether conditions are safe. Application roles grant access " +
            "to software features only — they never confer organizational " +
            "command authority, operational qualification, or rescue " +
            "readiness.",
        ),
        P(
          "Availability statements, qualification records, and equipment " +
            "records in SARbase are factual entries made by people. SARbase " +
            "does not independently verify a member's fitness, competence, " +
            "availability, or an asset's readiness.",
        ),
      ],
    },
    {
      id: "human-responsibility",
      heading: "5. Human and organizational responsibility",
      blocks: [
        P(
          "Participating organizations and their authorized personnel " +
            "remain solely responsible for operational decisions, " +
            "compliance with applicable law and regulation, training " +
            "standards, safety procedures, and emergency communications. " +
            "Organizations are responsible for keeping member, contact, " +
            "qualification, availability, equipment, and incident records " +
            "accurate and current, and for managing their users' access.",
        ),
      ],
    },
    {
      id: "communications",
      heading: "6. Communication limitations",
      blocks: [
        P(
          "Notifications travel over email, WhatsApp, internet, and mobile " +
            "networks operated by third parties. They may be delayed, " +
            "filtered, misconfigured, or fail entirely. SARbase notification " +
            "delivery must never be represented as a guaranteed emergency " +
            "alert, and message delivery is not evidence that a person " +
            "received, read, or will act on it. Organizations must maintain " +
            "independent emergency communication procedures.",
        ),
      ],
    },
    {
      id: "accounts",
      heading: "7. Accounts and security",
      blocks: [
        L([
          "Accounts are created and provisioned by participating organizations or the operator; SARbase has no public registration.",
          "You are responsible for protecting your credentials and for activity under your account, and must report suspected unauthorized use promptly to your organization and the operator.",
          "Access may be suspended or revoked for security, misuse, or at your organization's direction.",
        ]),
      ],
    },
    {
      id: "acceptable-use",
      heading: "8. Acceptable use",
      blocks: [
        P("You must not:"),
        L([
          "access SARbase or data you are not authorized to access, or attempt to bypass isolation or access controls;",
          "harass, threaten, or misuse personal information belonging to other people;",
          "disclose information obtained through SARbase without authorization;",
          "upload malicious content or attempt to interfere with, degrade, or probe the service or its infrastructure;",
          "use SARbase for anything unlawful under applicable law.",
        ]),
      ],
    },
    {
      id: "ip-and-data",
      heading: "9. Intellectual property and your organization's data",
      blocks: [
        P(
          "The operator retains all rights in the SARbase software, " +
            "documentation, and platform design. Content and records your " +
            "organization submits remain your organization's property; " +
            "hosting them in SARbase does not transfer ownership. Your " +
            "organization grants the operator only the limited right to " +
            "host, process, and transmit that content as needed to operate " +
            "and secure the service.",
        ),
      ],
    },
    {
      id: "availability",
      heading: "10. Availability and changes",
      blocks: [
        P(
          "SARbase is provided on a reasonable-efforts basis. Features may " +
            "change, be suspended, or be withdrawn; maintenance and updates " +
            "may cause interruption. The operator does not promise " +
            "uninterrupted or error-free operation.",
        ),
      ],
    },
    {
      id: "disclaimers",
      heading: "11. Disclaimers",
      blocks: [
        P(
          "To the maximum extent permitted by applicable law, SARbase is " +
            'provided "as is" and "as available", without warranties of any ' +
            "kind, express or implied, including warranties of " +
            "merchantability, fitness for a particular purpose, and " +
            "non-infringement. Without limiting the foregoing, the operator " +
            "does not warrant that notifications will be delivered, that " +
            "the service will be uninterrupted, or that it is suitable for " +
            "any particular operational use.",
        ),
        P(
          "Nothing in these Terms excludes or limits a warranty, right, or " +
            "liability that applicable law prohibits excluding or limiting.",
        ),
      ],
    },
    {
      id: "liability",
      heading: "12. Limitation of liability",
      blocks: [
        P(
          "To the maximum extent permitted by applicable law, the operator " +
            "is not liable for indirect, incidental, special, consequential, " +
            "or punitive damages; loss of data, profits, goodwill, or " +
            "revenue; service interruption; failures or outages of " +
            "third-party providers (including email, WhatsApp, hosting, " +
            "authentication, storage, or scanning services); or " +
            "consequences of operational decisions made by organizations " +
            "or their personnel using information recorded in SARbase.",
        ),
        P(
          "To the maximum extent permitted by applicable law, the " +
            "operator's aggregate liability arising out of or relating to " +
            "SARbase is limited to [LIABILITY CAP — to be set on legal " +
            "advice: e.g., the fees paid by the affected organization in " +
            "the twelve months preceding the claim, or a fixed amount]. " +
            "This limitation does not apply to liability that applicable " +
            "law prohibits limiting, including liability for willful " +
            "misconduct or gross negligence where non-excludable.",
        ),
      ],
    },
    {
      id: "indemnity",
      heading: "13. Indemnification",
      blocks: [
        P(
          "To the extent permitted by applicable law, each organization " +
            "agrees to indemnify the operator against claims arising from " +
            "the organization's unlawful use of SARbase, data it submits " +
            "without the right to do so, and operational decisions made by " +
            "its personnel — subject to the limits and procedures in any " +
            "applicable organization agreement and to legal review of this " +
            "provision's scope.",
        ),
      ],
    },
    {
      id: "suspension-termination",
      heading: "14. Suspension and termination",
      blocks: [
        P(
          "The operator may suspend access to protect the service, its " +
            "users, or third parties — including for security incidents, " +
            "unlawful use, or breach of these Terms — and will restore " +
            "access when the cause is resolved where practicable. " +
            "Organizations may end their use of SARbase; on termination, " +
            "the operator will make organization data available for export " +
            "for a reasonable period [RETENTION WINDOW — pending legal " +
            "decision] and may thereafter delete it, except records the " +
            "operator is required or justified in retaining.",
        ),
      ],
    },
    {
      id: "governing-law",
      heading: "15. Governing law and disputes",
      blocks: [
        P(
          "These Terms are governed by [GOVERNING LAW — pending " +
            "owner/legal approval], and disputes are subject to the " +
            "exclusive jurisdiction of [JURISDICTION VENUE — pending " +
            "owner/legal approval], without prejudice to mandatory " +
            "protections applicable law gives users or consumers.",
        ),
      ],
    },
    {
      id: "changes",
      heading: "16. Changes to these Terms",
      blocks: [
        P(
          "The operator may update these Terms. Material changes will be " +
            "announced with reasonable advance notice inside the " +
            "application or by email, will update the version and " +
            "effective date above, and where required will take effect " +
            "only after renewed acceptance. Continued use after the " +
            "effective date of a notified change constitutes acceptance " +
            "of the updated Terms where the law permits.",
        ),
      ],
    },
    {
      id: "contact",
      heading: "17. Contact",
      blocks: [
        P(`Questions about these Terms: ${PRIVACY_CONTACT_PLACEHOLDER}.`),
      ],
    },
  ],
};

export const LEGAL_DOCUMENTS: readonly LegalDocument[] = [
  PRIVACY_POLICY,
  TERMS_OF_SERVICE,
];

export function getLegalDocument(key: LegalDocument["key"]) {
  return LEGAL_DOCUMENTS.find((d) => d.key === key);
}
