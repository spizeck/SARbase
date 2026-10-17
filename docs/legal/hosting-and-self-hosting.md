# SARbase hosting & self-hosting policy

**Status:** informational policy — reflects the owner's decisions
(issue #139). Not itself a contract; the binding text for the hosted
service is the Terms of Service (`/terms`, `src/lib/legal/documents.ts`).

---

## Two different things: the software and the hosting

**SARbase the software** is free and open-source, published under the
GNU Affero General Public License v3.0 (AGPL-3.0) in the
[spizeck/SARbase repository](https://github.com/spizeck/SARbase) (see
`LICENSE`). Under AGPL-3.0 anyone may use, study, modify, and
redistribute the software — including running it as a network service —
subject to the license's terms, notably that a modified version run as
a network service must offer its corresponding source to users
interacting with it (AGPL §13).

**SARbase the hosted instance** is a separate thing: a deployment of
that software which the developer currently operates **voluntarily and
free of charge** for participating search-and-rescue organizations.
Using the hosted instance is optional; the license rights in the
software exist independently of it.

Free software and free hosting are not the same promise:

- The AGPL-3.0 grant is permanent for the code you have — nobody can
  revoke it by discontinuing a hosted service.
- The hosted instance comes with **no service-level agreement, no
  uptime guarantee, no promised support, and no commitment to host
  forever.** The developer may change, suspend, or discontinue it with
  reasonable advance notice where practicable (see Terms §16 for the
  data-handover commitments that apply).

## Infrastructure

The developer-hosted instance runs on infrastructure the developer
selected and pays for/arranges personally:

| Function            | Provider                          | Region                |
| ------------------- | --------------------------------- | --------------------- |
| Application hosting | Vercel                            | deployment-configured |
| Database            | Neon (PostgreSQL)                 | deployment-configured |
| Authentication      | Google Firebase Authentication    | provider global       |
| File storage/scan   | AWS S3 + GuardDuty (when enabled) | deployment-configured |
| Transactional email | Resend (when configured)          | provider global       |
| WhatsApp messaging  | Meta (when enabled + consented)   | provider global       |
| Error monitoring    | Sentry (when enabled)             | provider-configured   |

"Deployment-configured" means the actual region is an operator setting,
not a policy promise — the Privacy Policy deliberately claims no
residency. Regions can be confirmed for a given deployment on request.

**There is no obligation to relocate.** The developer does not
undertake to: host exclusively in the EU or any specific region, change
providers, open additional provider accounts, build dedicated regional
infrastructure, satisfy organization-specific procurement or funding
conditions, or obtain certifications not actually held. Choosing
non-EU infrastructure does not by itself remove obligations under
privacy law that otherwise applies — the point is that this instance
makes no residency promise, not that it is beyond the law.

## For organizations whose funders require European (or other regional) hosting

If a funding agreement, procurement rule, or internal policy requires
hosting that this instance does not provide, the supported paths are:

1. **Self-host SARbase.** Deploy the AGPL-3.0 source on infrastructure
   that meets the requirement. Your organization then controls regions,
   processors, retention, and its own privacy notice. Note the license
   obligations (source availability to your users) and that
   self-hosting means your own security, backups, updates, and
   compliance work.
2. **Use different software.** If self-hosting isn't practical, the
   honest answer is that this hosted instance isn't a fit — not that
   the developer must rebuild infrastructure to meet the condition.

What is not on the table: requiring the developer-hosted instance to
migrate providers or regions, or to open paid accounts, to satisfy an
organization's external requirements.

## Data and transition

- Workspace records belong to the organization. The built-in export
  functions (organization exports, 42 datasets) are the supported way
  to take data out at any time during use. If the **operator**
  discontinues hosted service, a reasonable post-termination export
  window applies (window pending legal decision — Terms §16). An
  organization choosing to leave is responsible for exporting before
  it departs.
- The developer does not provide free migration, transformation, or
  configuration services as an entitlement. Help may be offered at the
  developer's discretion, but departing organizations should plan on
  doing their own transition work.
- Outstanding privacy requests are handled per the Privacy Policy;
  audit records the operator is required or justified to keep may be
  retained for that purpose.

## Separation of code and data

- The **source repository** (public, AGPL-3.0) contains the software —
  never production data, credentials, or secrets.
- **Production data** (organization workspaces, member records,
  attachments) lives in the hosted infrastructure and is not part of
  the repository or the license grant.
- **Production credentials, backups, provider accounts, and
  configuration** belong to the developer's deployment. Self-hosting
  creates a new, empty deployment; nothing entitles an organization to
  the developer's accounts, secrets, or stored data beyond the
  authorized export of its own workspace records.

## Responsibilities of independent operators

If you run your own SARbase instance:

- **You are the operator.** You choose processors and regions, write
  your own privacy notice, set retention, and carry the legal
  responsibilities of a data controller/processor for the data you
  hold.
- **AGPL-3.0 obligations apply.** In particular, if you modify the
  program, section 13 requires your modified version to offer its
  corresponding source to users interacting with it over a network.
  Running an unmodified copy does not itself trigger that specific
  obligation — but all other license conditions still apply.
- **Security is yours.** The hosted instance's configurations (GuardDuty
  scanning, session hardening, secret storage) are in the repo for you
  to reproduce; whether you do is your responsibility.
- **No implied support.** The developer-hosted service's availability,
  and the developer's time, are not part of the license. Issues and
  pull requests are welcome through the repository; there is no
  entitlement to fixes or assistance.
- The software is provided under AGPL-3.0's own warranty disclaimer;
  that does not remove obligations the law refuses to let go of.
