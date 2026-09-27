# SARbase

**Open-source operations and records for volunteer search and rescue organizations.**

SARbase helps volunteer marine search and rescue organizations manage the information surrounding their operations: people, training, qualifications, equipment, maintenance, callouts, incident records, expenses, receipts, and organizational history.

The goal is simple: make it easier for volunteer SAR organizations to stay organized, notify their crews, maintain reliable records, and find important information when they need it.

## What SARbase is

SARbase is an administrative, notification, and recordkeeping system.

It is designed to help organizations answer questions such as:

- Who is currently available?
- Who responded to a callout?
- When was an incident opened, and what happened afterward?
- When does a crew member's certification expire?
- Who has been participating in training?
- When was a piece of equipment last inspected?
- When is its next inspection due?
- Where is a particular piece of equipment stored?
- What maintenance has been performed on a vessel?
- Where did we buy that replacement part?
- Is there a receipt for it?
- What records do we have from an incident several years ago?

SARbase is intended to become an organization's durable operational memory.

## What SARbase is not

**SARbase does not practice search and rescue.**

It does not provide search planning, navigation guidance, rescue tactics, operational recommendations, launch decisions, or command decisions.

SARbase records information and helps people communicate. Qualified SAR personnel remain responsible for all operational decisions.

The organization defines its procedures and requirements. SARbase helps remember, organize, communicate, and document them.

## Planned capabilities

### People

- Volunteer and staff records
- Contact information
- Roles
- Availability and on-island/off-island status
- Qualifications and certifications
- Certification expiry dates
- Training history

### Callouts

- Create an incident
- Notify crew
- Allow volunteers to respond as available or unavailable
- Track responses
- Automatically record important timestamps
- Preserve a callout history

### Incidents

- Incident details
- Participating personnel
- Vessels and equipment used
- Timeline
- Operational notes
- Attachments
- After-action notes
- Review and closure
- Audit history

### Training

- Training events
- Attendance
- Training topics
- Notes and supporting documents
- Participation history
- Visibility into inactive or infrequently participating members

### Vessels and equipment

- Vessels, engines, trailers, radios, safety equipment, and other assets
- Equipment locations
- Inspection history
- Next inspection dates
- Expiration dates
- Condition and status
- Defects
- Maintenance and repair history
- Manuals and supporting documents

### Maintenance

- Maintenance records
- Inspections
- Defects
- Repairs
- Parts and materials
- Related expenses and receipts
- Service dates and intervals

### Expenses

- Volunteer receipt submission
- Vendors
- Expense categories
- Reimbursement status
- Receipt and invoice attachments
- Relationships to incidents, training, assets, maintenance, and equipment
- Bookkeeping exports

SARbase is not intended to replace accounting software.

### Records and search

Search across the organization's history to find incidents, people, equipment, maintenance, purchases, vendors, notes, and other records.

A question such as "Where did we buy that 3/8 line for Gary?" should not require searching old messages or relying on somebody's memory.

### Reminders

SARbase can help surface factual administrative deadlines such as:

- Certification expiration
- Equipment inspection dates
- Flare expiration
- Scheduled maintenance
- Document renewal

These reminders do not constitute an assessment of operational readiness.

## Designed for organizations of different sizes

SARbase is being designed around organizations and units rather than a particular island or rescue service.

A small volunteer unit should be able to use it without unnecessary complexity, while the underlying model should allow multiple units or organizations to adopt it independently.

The first implementation is being developed with volunteer marine SAR operations in mind.

## Project principles

**Simple during an emergency.**  
Administrative software should not get in the crew's way.

**Humans make operational decisions.**  
SARbase organizes information. It does not determine how a rescue should be conducted.

**Keep the history.**  
Important records should have an auditable history so corrections do not silently rewrite the past.

**Make information easy to find.**  
Records have little value if nobody can retrieve them later.

**Own your data.**  
Organizations should be able to export their records and attachments.

**Avoid unnecessary lock-in.**  
External services should be replaceable where practical.

**Build from real needs.**  
Features should solve problems experienced by actual SAR organizations rather than speculative requirements.

**Keep it accessible to volunteers.**  
SARbase should not require an IT department to operate.

## Technology

SARbase is built as a modern web application using:

- Next.js
- TypeScript
- PostgreSQL
- Prisma
- React
- Tailwind CSS

The project is based on production-tested open-source application foundations and is designed to support self-hosted deployments.

## Status

SARbase is currently under initial development.

The data model and interfaces may change significantly before the first stable release. It should not yet be relied upon as the sole repository for operational records.

## Contributing

Contributions are welcome.

SARbase is intended to be shaped by the real needs of volunteer search and rescue organizations. Bug reports, feature requests, documentation improvements, translations, accessibility improvements, and code contributions are all valuable.

Operational SAR doctrine is outside the scope of the project. Proposed features that attempt to provide search planning, rescue tactics, navigation guidance, or operational decision-making may be declined even when technically feasible.

## Security

Please do not publicly disclose vulnerabilities involving authentication, authorization, personal information, incident records, or other sensitive data.

A dedicated security reporting process will be documented as the project approaches its first public release.

## License

SARbase is free and open-source software licensed under the **GNU Affero General Public License v3.0 (AGPL-3.0)**.

See `LICENSE` for the complete license terms.
