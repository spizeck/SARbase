# WhatsApp production activation runbook

Owner-run procedure for taking the WhatsApp channel live on the SARbase
production deployment. The code is implemented but **inactive by
design** — production fails closed until every variable below is set
correctly. Nothing in this runbook is automated; each step is a human
decision with real-world consequences (Meta billing, member messaging).

Related docs: [`notifications.md`](notifications.md) (channel and
consent semantics), [`whatsapp-templates.md`](whatsapp-templates.md)
(template registration), [`production-readiness.md`](production-readiness.md).

## Status semantics — read first

| Status SARbase shows    | What it actually means                                                                              |
| ----------------------- | --------------------------------------------------------------------------------------------------- |
| `ACCEPTED`              | Meta took the message. Not delivery.                                                                |
| `SENT` (delivery event) | Meta forwarded it toward the recipient's device.                                                    |
| `DELIVERED`             | The recipient's device received it. **Not** acknowledgment.                                         |
| `READ`                  | WhatsApp reports the member opened it. **Not** acknowledgment, availability, or consent to respond. |
| `FAILED`                | Meta could not deliver — the attempt carries the safe error code.                                   |

Volunteer acknowledgment exists only on the callout response record.
Never brief a coordinator that "delivered" means "coming".

## Prerequisites

- Meta Business Portfolio for Saba SAR (business.facebook.com) — a
  SARbase deployment must never share a personal or unrelated business
  account.
- A **dedicated phone number** for the sender. Do not reuse Sea Saba's
  existing WhatsApp Business account or a number already registered on
  consumer WhatsApp — a number can only be registered to one WhatsApp
  product at a time, and migrating a live community number risks
  losing its history. A fresh SIM/eSIM or a number Meta provisions for
  testing both work; decide deliberately.
- Business verification in Meta (documents may be required; can take
  days) — needed for higher messaging limits and display-name approval.
- Vercel project access to set environment variables.
- The `main` deployment running the build that includes the WhatsApp
  channel (PRs #105+).

## Phase 1 — Meta setup

1. **Create the WhatsApp Business Account (WABA).** In the Meta
   Business Portfolio: WhatsApp Accounts → Add. Record the **WABA ID**.
2. **Add the sender phone number** to the WABA. Record the
   **phone number ID** (numeric — _not_ the phone number itself).
   Verify the number (SMS/voice to the SIM you control).
3. **Create a system user** (Business Settings → Users → System
   users) and generate an **access token** scoped to the WABA with
   `whatsapp_business_messaging` and `whatsapp_business_management`.
   System-user tokens do not expire like user tokens; store it only in
   Vercel env vars — never in the repo, chat, or docs.
4. **Pin the Graph API version.** Check the current stable version in
   Meta's changelog and set `WHATSAPP_API_VERSION` (e.g. `v24.0`).
   Meta deprecates versions roughly quarterly; an unpinned call can
   break silently. Calendar a version review every quarter.
5. **Register the templates** per `docs/whatsapp-templates.md` and
   wait for APPROVED status on each one the pilot needs.

## Phase 2 — Webhook wiring

6. **Generate a webhook verify token**: `openssl rand -hex 32` — save
   it for the env vars.
7. In the Meta app dashboard (developers.facebook.com → your app →
   WhatsApp → Configuration): set the **Callback URL** to
   `https://<production-domain>/api/webhooks/whatsapp` and the
   **verify token** to the generated value. Meta issues a GET
   challenge — the route echoes it only when the token matches.
8. **Subscribe to the `messages` webhook field** on the WABA — that is
   what delivers `statuses` callbacks. (Inbound `messages` also
   arrive; SARbase ignores them.)
9. Record the **app secret** (App → Settings → Basic). This is
   `WHATSAPP_APP_SECRET`, used to verify `X-Hub-Signature-256` on
   every callback.

## Phase 3 — Vercel environment variables

Set for the **production** environment only:

| Variable                        | Source                   |
| ------------------------------- | ------------------------ |
| `WHATSAPP_PROVIDER`             | `meta`                   |
| `WHATSAPP_ACCESS_TOKEN`         | Phase 1, step 3 — SECRET |
| `WHATSAPP_PHONE_NUMBER_ID`      | Phase 1, step 2          |
| `WHATSAPP_API_VERSION`          | Phase 1, step 4          |
| `WHATSAPP_APP_SECRET`           | Phase 2, step 9 — SECRET |
| `WHATSAPP_WEBHOOK_VERIFY_TOKEN` | Phase 2, step 6 — SECRET |

Do **not** set `ALLOW_WHATSAPP_IN_PREVIEW` on production — it exists
only for deliberate preview sandbox testing.

A redeploy is required after env changes. Until then the route and the
provider fail closed (503 / `config_missing`) — a safe no-op, not an
error.

## Phase 4 — Sandbox verification (before members)

10. In Meta's API setup, add a **test recipient** (your own phone) —
    test sends are free and do not need a fully verified business for
    the sandbox sender.
11. Give that test member a SARbase record with your number, set
    `notifyWhatsapp`, and record WhatsApp consent through the member's
    own account page (consent is self-service only — you cannot
    consent for someone else even as admin).
12. Trigger a single test notification (e.g. a callout to an audience
    of just the test member — create it in a throwaway state and close
    it after). Expected:
    - The notification shows `ACCEPTED` with provider `meta` and a
      `wamid` provider message id.
    - Within seconds, a `NotificationDeliveryEvent` records `SENT`
      then `DELIVERED` (and `READ` if you open it).
    - The member's phone receives the template with the correct org
      name, title, and working response link.
13. Respond through the link — the response records on the invitation.
    Verify in the callout detail that delivery state and response state
    are displayed as separate facts.

## Phase 5 — Production activation checklist

- [ ] Business verified in Meta; display name approved.
- [ ] Sender number is dedicated (not shared with consumer WhatsApp).
- [ ] Templates APPROVED (at minimum alert + cancellation).
- [ ] All six env vars set on production; redeployed.
- [ ] Webhook subscribed; a real status callback has been observed in
      `NotificationDeliveryEvent` (not just a successful challenge).
- [ ] Messaging limit checked (Meta starts new senders at ~250
      business-initiated conversations/day — plenty for a pilot, but
      confirm the tier in WhatsApp Manager → Messaging limits).
- [ ] Member consent captured for every member who will receive
      WhatsApp callouts — unconsented members are suppressed, and the
      coordinator sees `consent_missing`, not a silent skip.
- [ ] Coordinator briefed: `DELIVERED`/`READ` are provider facts, not
      acknowledgment; responses only count on the response record.

## Consent and opt-out operations

- Consent is self-service: the member records it on their account page;
  it is timestamped, attributed, and audited (MemberContactChange).
  Administrators **cannot** grant it for a member — by design.
- Members opt out the same way. Honor external opt-out signals
  (verbal, WhatsApp STOP reply to the sender) by asking the member to
  record it themselves; if they cannot, document the request and
  disable `notifyWhatsapp` as staff — which stops sends via
  `preference_disabled` without falsifying consent records.
- Never re-import consent for a member who opted out without a fresh,
  documented, member-initiated grant.

## Rollback / disable

Fastest first:

1. **Set `WHATSAPP_PROVIDER=fake`** on production and redeploy —
   WhatsApp requests become no-ops against the deterministic fake; the
   notification rows still record honestly, email is untouched. (This
   is the emergency off switch.)
2. Remove `WHATSAPP_ACCESS_TOKEN` and redeploy — the provider fails
   closed with `config_missing`; queued retries surface as config
   failures, not sends.
3. In Meta, unsubscribe the webhook field if callbacks should stop.
4. Notify coordinators via org channels that WhatsApp alerts are off;
   member `preferredChannel` settings remain — no data is destroyed —
   so reactivation is a repeat of Phase 3.

## Cost considerations

- **Per-conversation pricing**: Meta bills per 24-hour conversation
  window, category-priced (UTILITY is cheaper than MARKETING; rates
  vary by recipient country — Caribbean Netherlands is typically
  "rest of world"). A callout to 30 members ≈ 30 conversations;
  multiple sends inside one 24h window cost once.
- Free-tier credit exists but is small — assume paid.
- No SARbase-side cost: the webhook route is a normal function
  invocation; delivery events are small rows.
- Budget guidance for the pilot: even daily callouts to ~40 members
  stay well under typical NGO budgets, but **assign cost monitoring to
  the treasurer/admin** — Meta bills the payment method on the WABA.

## Failure modes to expect

| Symptom                           | Likely cause                                    | Action                            |
| --------------------------------- | ----------------------------------------------- | --------------------------------- |
| `config_missing` on attempts      | Env vars unset/incomplete                       | Phase 3                           |
| `provider_auth`                   | Token revoked/expired/wrong WABA                | Regenerate system-user token      |
| `provider_rejected` (template)    | Template not approved / paused / param mismatch | `docs/whatsapp-templates.md`      |
| `consent_missing` suppressions    | Member never consented or opted out             | Member self-service consent       |
| `destination_missing`             | Member has no valid phone                       | Fix member record                 |
| No delivery events after ACCEPTED | Webhook not subscribed / app secret wrong       | Phase 2; check Meta delivery logs |
| Webhook 401s in Meta dashboard    | `WHATSAPP_APP_SECRET` mismatch                  | Re-copy app secret                |
