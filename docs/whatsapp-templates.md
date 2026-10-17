# WhatsApp template registration guide

How SARbase internal notification templates map to Meta-approved
WhatsApp message templates, and what an operator must do in WhatsApp
Manager before any send can succeed.

**Nothing in this document implies a template is approved.** Meta
reviews each template manually. `metaName` values in
`src/lib/notifications/whatsapp-templates.ts` are _proposals_ — until a
template with that exact name, category, language, and parameter count
is APPROVED in the WhatsApp Business Account, sends fail at Meta with a
template error and are recorded as `provider_rejected` attempts.

## Rules for proposed wording

Meta rejects templates that look spammy, and SARbase's own privacy
contract is stricter still:

- **Minimal content.** Organization name, a short subject, and the
  secure response link — never incident details, locations, medical
  information, or member personal data beyond what the member already
  knows (their org's name).
- **No sensitive incident content.** A callout title is the most
  specific thing transmitted. Coordinators should write callout titles
  as they would a radio check — "Missing hiker — respond if
  available", not a location, a medical narrative, or names.
- **Body parameters only.** Meta body parameters cannot contain
  newlines, tabs, or runs of more than 4 spaces —
  `whatsapp-templates.ts` sanitizes for this; keep proposed wording
  inside that envelope.
- **English only for the pilot.** Dutch/Papiamento localization is a
  follow-up: each language is a separate Meta template that must be
  translated _and_ approved. Do not send unreviewed translations.

## Proposed templates

| Internal template id   | Proposed Meta name             | Category | Lang | Parameters | Proposed body                                                |
| ---------------------- | ------------------------------ | -------- | ---- | ---------- | ------------------------------------------------------------ |
| `callout_invitation`   | `sarbase_callout_alert`        | UTILITY  | en   | 3          | `{{1}} is requesting assistance: {{2}}. Respond here: {{3}}` |
| `callout_update`       | `sarbase_callout_update`       | UTILITY  | en   | 2          | `{{1}} posted an update for: {{2}}.`                         |
| `callout_cancellation` | `sarbase_callout_cancellation` | UTILITY  | en   | 2          | `{{1}} cancelled the callout: {{2}}.`                        |
| `training_reminder`    | `sarbase_training_reminder`    | UTILITY  | en   | 2          | `{{1}} reminder: {{2}}.`                                     |
| `admin_notice`         | `sarbase_admin_notice`         | UTILITY  | en   | 2          | `{{1}} needs your attention: {{2}}.`                         |

Parameter order is positional (`{{1}}`, `{{2}}`, `{{3}}`) and must match
`WHATSAPP_TEMPLATES[...].parameters(ctx)` exactly:

- `callout_invitation`: `{{1}}` = organization name, `{{2}}` = callout
  title, `{{3}}` = the member's personal response URL.
- All others: `{{1}}` = organization name, `{{2}}` = short subject.

## Registering a template in WhatsApp Manager

1. Open **WhatsApp Manager → your WABA → Message templates → Create
   template**.
2. Category **UTILITY** — these are service messages to consenting
   members, not marketing. (Marketing-category templates cost more and
   are held to stricter review; these are not marketing.)
3. Name: exactly the `metaName` above (`sarbase_callout_alert`, …).
   Names are lowercase with underscores; a typo means the code's
   `metaName` resolves to nothing.
4. Language **English** (`en`).
5. Body: the proposed wording, with the same parameter count and
   order. Meta shows a sample — fill samples with plausible values
   (`Saba SAR`, `Training evening Thursday`, `https://example.org/…`)
   to speed review.
6. Submit and wait for **APPROVED**. Review is usually minutes to
   hours; if REJECTED, read the stated reason, adjust wording, and
   resubmit — do not rename the template to dodge review.
7. Repeat per template. Only templates this org actually uses need
   approval — the pilot needs at minimum `sarbase_callout_alert` and
   `sarbase_callout_cancellation`.

## The 24-hour customer-service window

Business-initiated WhatsApp messages may **only** be templates. A
member's reply (or a free-form message to the sender number) opens a
24-hour session window during which free-form replies are allowed —
SARbase does not use that window; every send is a template send.
Template choice therefore affects deliverability: an unapproved or
paused template is an immediate `provider_rejected`, not a degraded
send.

## Opt-out

Meta enforces platform-level STOP handling poorly for Cloud API
senders — **SARbase's own consent model is the enforceable control**:
a member's opt-out sets `whatsappOptedOutAt`, dispatch suppresses with
`consent_missing`, and the MemberContactChange audit row proves when
consent changed. If a member replies STOP to the sender number, an
operator records the opt-out through the member's account page (the
member can also do it themselves). See
`docs/whatsapp-production-activation.md`.
