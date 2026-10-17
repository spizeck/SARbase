# SARbase Organization Agreement — DRAFT for legal review

**Status:** DRAFT — not offered, accepted, or binding. Prepared as the
starting point for a per-organization agreement / data-processing
addendum for the **developer-hosted instance** of SARbase. Every
bracketed item is an owner/legal decision. Review with counsel before
presenting to any organization.

> **Revision note (issue #139):** this draft has been rewritten for the
> actual service model — SARbase is free open-source software (AGPL-3.0)
> and the hosted instance is provided voluntarily by an individual
> developer, without fees, SLA, or infrastructure-relocation
> obligations. Commitments below are calibrated to that model: honest
> and limited, not absent.

---

## Organization Agreement for SARbase

This Agreement is between **[OPERATOR LEGAL ENTITY — the individual
developer, name to be confirmed]** ("the Operator") and
**[ORGANIZATION LEGAL NAME]** ("the Organization"), governing the
Organization's use of the developer-hosted SARbase instance ("the
Service").

### 0. Nature of the service

0.1. The SARbase software is free and open-source, licensed under the
GNU Affero General Public License v3.0 (AGPL-3.0). The Service is the
Operator's personal hosted deployment of that software, provided free
of charge and at the Operator's discretion. This Agreement does not
create a paid service, a service-level agreement, or a hosting
obligation of indefinite duration.

0.2. This Agreement governs the hosted Service only. It does not
modify AGPL-3.0, restrict rights the license grants, or prevent the
Organization from deploying the software independently (see
`docs/legal/hosting-and-self-hosting.md`).

0.3. The Service runs on international cloud infrastructure selected by
the Operator. The Operator does not undertake to host in any particular
region, change providers, open additional provider accounts, satisfy
organization-specific procurement or funding conditions, or obtain
certifications not expressly held. **Before relying on the Service, the
Organization is responsible for determining that this infrastructure
meets its own legal, funding, and policy requirements.** If it does
not, the Organization may decline the Service and self-host under
AGPL-3.0 instead.

### 1. Roles

1.1. The Operator develops SARbase and voluntarily operates the hosted
instance the Organization uses to manage members, qualifications,
equipment, communications, callouts, incidents, and related records.

1.2. The Organization controls its workspace: which records it keeps,
who it authorizes, and how it uses the information. For personal data
in the workspace, the Organization is the data controller (or
equivalent role under applicable law); the Operator processes that
data on the Organization's behalf as described in this Agreement and
the Privacy Policy.

1.3. Individual users are additionally bound by the SARbase Terms of
Service; where this Agreement and the Terms conflict for the
Organization, this Agreement controls.

### 2. Service scope and operational independence

2.1. The Service is administrative, recordkeeping, and communication
software. It does not provide rescue services, emergency dispatch, or
operational command authority, and it does not certify personnel,
qualifications, equipment readiness, crew sufficiency, or the safety
of any operation.

2.2. The Organization retains exclusive responsibility for operational
decisions, emergency communications, compliance with applicable law,
training and safety standards, and the accuracy of records it
maintains in the Service.

2.3. Notifications (email, WhatsApp, or otherwise) traverse
third-party networks and may fail or be delayed. The Organization must
maintain independent emergency communication procedures and must not
represent Service notifications as guaranteed alerts.

### 3. Organization responsibilities

3.1. The Organization will: (a) ensure it has a lawful basis to submit
personal data about members, emergency contacts, and other
individuals, and inform data subjects (including emergency contacts)
as required; (b) authorize users appropriately and revoke access
promptly when people leave; (c) maintain accurate records; (d) respond
to member privacy requests concerning workspace records; and
(e) maintain operational procedures that do not depend solely on the
Service.

3.2. The Organization is responsible for determining whether its
procurement, funding, residency, insurance, and operational
requirements permit use of the hosted Service, and for satisfying
those requirements itself.

3.3. The Organization will not use the Service unlawfully, submit data
it lacks the right to submit, or permit users to misuse the Service.

### 4. Operator responsibilities

4.1. The Operator will handle workspace data with reasonable care,
maintaining the technical measures described in the Privacy Policy
(organization isolation, server-enforced authorization, attachment
malware scanning, audit logging), and will process workspace personal
data only as needed to operate and secure the Service or as required
by law. These commitments describe a free, personally operated
service; they are not a warranty of outcomes, uptime, or fitness for a
particular operational use, and nothing in this Agreement excludes
liability the law prohibits excluding.

4.2. The Operator selects the Service's processors (listed in the
Privacy Policy) using reasonable care and will notify the Organization
of material changes to that set. The Operator does not guarantee any
processor's availability or performance — provider failures are a
known limitation of the Service (Terms §9) — but will act reasonably
to restore the Service when provider issues arise.

4.3. After becoming aware of and confirming a security breach
resulting in unauthorized access to the Organization's workspace
data, the Operator will notify the Organization as soon as reasonably
practicable, describing known scope and remediation. The Organization
remains responsible for notifications owed to data subjects or
authorities under its own obligations.

### 5. Shared responsibilities

5.1. The parties will cooperate reasonably on: privacy requests the
Organization cannot resolve alone (the Operator provides technical
means; the Organization decides responses), security incidents
affecting workspace data, authorized data exports, and orderly
termination.

5.2. Each party will act in good faith to resolve problems
informally before escalating.

### 6. Data, export, and retention

6.1. Workspace records remain the Organization's property. The
Operator acquires no ownership and uses them only to operate the
Service.

6.2. The Organization can export its records through the Service's
export functions at any time, and is encouraged to keep its own
exports of anything it cannot afford to lose.

6.3. The Operator retains data per the retention policy in the Privacy
Policy, including preservation of audit and change history. On
termination, workspace data remains available for authorized export
for **[RETENTION WINDOW — pending legal decision]**, after which the
Operator may delete or anonymize it except records required or
justified to be retained, which are kept only for that purpose.

### 7. Suspension, termination, and handover

7.1. The Organization may stop using the Service at any time and is
responsible for exporting the records it needs.

7.2. The Operator may suspend a workspace where reasonably necessary to
protect the Service or others, with notice where practicable, and may
end hosted service for the Organization — or discontinue the hosted
service entirely — with **[NOTICE PERIOD]** advance notice where
practicable.

7.3. On termination the provisions of section 6.3 apply. The Operator
does not undertake to provide migration, transformation, or
configuration assistance beyond making authorized exports available,
though the open-source software remains available for the
Organization's own deployment.

### 8. Liability

8.1. The liability terms of the Terms of Service apply between the
parties, with the aggregate cap of **[LIABILITY CAP — pending legal
decision; the free provision of the Service should inform the figure]**
applying to claims under this Agreement, except where law prohibits
the limitation.

8.2. **[COUNSEL REVIEW]** The Organization indemnifies the Operator
against claims arising from its unlawful use of the Service, data
submitted without the right to do so, and operational decisions of its
personnel — a scope to be confirmed by counsel as enforceable and
proportionate for a free service.

### 9. General

9.1. Governing law: **[GOVERNING LAW — pending]**. Venue:
**[JURISDICTION VENUE — pending]**.

9.2. This Agreement, the Privacy Policy, and the Terms of Service form
the entire agreement for the Service; changes require written notice
per the Terms' change process, or signed amendment where required.

9.3. If any provision is unenforceable, the remainder continues. This
Agreement does not modify AGPL-3.0 and confers no rights in the
software beyond those the license already grants.
