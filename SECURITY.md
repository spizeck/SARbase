# Security policy

SARbase is an early-stage open-source project. It has not yet had a stable
release, and the security process described here will evolve as the
project matures.

## Scope

SARbase is intended to hold sensitive organizational data, including
member contact information, incident records, attachments, certificates,
and receipts or other financial records.

Vulnerabilities are especially serious when they could expose, alter, or
destroy that data — for example issues involving authentication,
authorization, data access across organizations, file attachments, or
injection.

## Reporting a vulnerability

**Please do not disclose vulnerabilities publicly** — do not open a public
issue, pull request, or discussion describing a vulnerability, especially
one involving sensitive data.

Report vulnerabilities privately through GitHub's private vulnerability
reporting:

1. Go to the repository's **Security** tab.
2. Choose **Report a vulnerability** (private vulnerability reporting is
   enabled on this repository).
3. Describe the issue, affected versions/commits, reproduction steps, and
   potential impact.

This creates a private channel with the maintainers where a fix can be
coordinated before any public disclosure.

If private vulnerability reporting is unavailable to you, open a minimal
public issue asking for a private contact channel — without describing
the vulnerability itself.

## Expectations

- Reports are acknowledged as soon as a maintainer is able; this is a
  volunteer-run project and no formal response-time guarantee exists yet.
- We will coordinate disclosure timing with you and credit reporters who
  want credit, once a fix is available.
- Please give us a reasonable opportunity to fix an issue before public
  disclosure.

## Supported versions

Until a first stable release exists, only the latest commit on the
default branch is considered supported.
