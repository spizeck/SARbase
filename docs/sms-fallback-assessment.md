# SMS fallback assessment — Saba SAR pilot

Should SARbase add an SMS channel alongside email and WhatsApp for the
pilot? Assessment and recommendation. **No SMS provider has been added
and no automatic fallback exists — this is a decision document, not an
implementation.**

## The reliability question

WhatsApp delivery needs data connectivity (cellular data or Wi-Fi) on
the recipient's device. Saba is small and mountainous; mobile data
coverage exists (UTS/Flow and TelEm on-island, plus roaming) but dead
spots are plausible at trailheads, on the water, and in power outages.
SMS rides the signaling channel — it works on 2G voice-only coverage
and when data is congested or a data plan has lapsed. For an emergency
alert, SMS is materially more likely to reach a phone at the edge of
coverage.

Email is a poor emergency channel but a fine administrative one —
already implemented.

## Constraints that argue against rushing SMS

- **Cost.** SMS to Caribbean Netherlands numbers runs roughly
  **$0.07–0.18 per segment** (Sinch ~$0.07, Twilio ~$0.17; verify
  current rate cards). WhatsApp moved to **per-message** pricing in
  July 2025 — utility templates land around **$0.008–0.02 per
  delivered message** depending on Meta's market mapping, billed only
  on delivery, so SMS is roughly an order of magnitude more expensive
  per alert _and_ billed on send rather than delivery. Every callout
  to N members is N paid messages either way; retries and long bodies
  (multi-segment) multiply SMS further.
- **No delivery guarantee either.** SMS delivery receipts (DLRs) are
  carrier- and region-dependent and unreliable on many Caribbean
  routes; "sent" is usually all you get. WhatsApp's delivered/read
  callbacks are actually _better_ observability than SMS offers here.
- **A second consent surface.** SMS opt-in/opt-out handling differs by
  provider (STOP keywords are usually mandatory and provider-managed)
  and would need the same explicit-consent treatment WhatsApp got —
  not free.
- **Automatic fallback is dangerous.** "Send WhatsApp, fall back to SMS
  if undelivered" duplicates emergency alerts on flaky connections,
  doubles cost, and — worst — trains members that every callout
  arrives twice. The sprint requirement of _no silent channel
  substitution_ applies equally to fallback.
- **One more secret/vendor.** Another API key, another webhook, more
  activation surface for a pilot that is already at the edge of what a
  volunteer org can operate.

## What the existing architecture already gives us

- A member can pick `preferredChannel` deliberately; coordinators see
  per-invitation notification state including suppressions
  (`consent_missing`, `preference_disabled`, `destination_missing`).
  The gap SMS would close — "member's phone has no data" — is already
  partially visible: the coordinator sees the invitee did not respond,
  and SARbase never pretends delivered means coming.
- The response link works on any phone that can open a URL; members
  can also respond from their account, so a callout email + account
  response covers no-WhatsApp phones.
- The provider seam (`NotificationProvider`, per-channel resolution,
  idempotency, attempts, delivery events) was built channel-agnostic —
  an `SMS` enum value, a preference flag (`notifySms` already exists on
  the preference model), a provider adapter, and template-free body
  rendering are the only new pieces. Estimated effort: comparable to
  the WhatsApp PR A + B pair, plus consent fields for SMS.

## Recommendation

**Do not add SMS for the pilot. Reassess after the first month of live
callouts, using real suppression/non-response data.**

Rationale:

1. The pilot population is small and known — coordinators can
   pre-flight contactability (ask each member once: "did the test
   callout reach you?") far more reliably than any protocol can.
2. WhatsApp's delivery callbacks give better evidence of reach than
   SMS DLRs would on Caribbean routes.
3. Email remains a real second channel — not silent substitution, but
   an explicit member choice.
4. The true emergency fallback for an unreachable responder is the
   coordinator calling them — a human decision SARbase deliberately
   never automates.

**Trigger conditions to revisit:** (a) a material share of members
cannot or will not use WhatsApp; (b) observed `FAILED`/no-event
deliveries during an actual callout; (c) the org explicitly asks for
SMS and accepts the cost. If triggered, the clean implementation path
is: `SMS` channel enum + preference flag → provider-neutral adapter
(injectable HTTP client, normalized outcomes) → optional delivery
events via provider webhook → per-member `preferredChannel: "SMS"` —
all on existing seams, no parallel architecture.

**If SMS is ever added: still no automatic cross-channel fallback.**
Duplicate alerting on flaky links is worse than one honest channel.
Fallback belongs in coordinator judgment ("she hasn't responded —
call her"), not code.
