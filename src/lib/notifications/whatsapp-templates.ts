import { CALLOUT_INVITATION_TEMPLATE } from "@/lib/domain/calloutTokens";

/**
 * Internal → Meta template registry for the WHATSAPP channel
 * (issue #100).
 *
 * SARbase notification templates (`Notification.template`) are
 * INTERNAL identifiers. `metaName` is the PROPOSED approved-template
 * name an operator creates in WhatsApp Manager — registration here is
 * not proof Meta approved anything (docs/whatsapp-templates.md
 * describes the out-of-band approval step). A send against an
 * unapproved name comes back from Meta as a template error and is
 * recorded as a provider rejection.
 *
 * Parameters are positional body parameters ({{1}}, {{2}}, …) matching
 * the proposed wording in docs/whatsapp-templates.md. Parameter
 * content is minimal by contract: organization name, a short subject,
 * and the secure response link — never incident details, medical
 * information, or raw operational notes.
 */

export interface WhatsAppTemplateContext {
  /** The organization's display name. */
  organizationName: string;
  /** Short subject (callout title, training summary, notice text). */
  subject: string | null;
  /** Secure one-off link resolved at dispatch — never persisted. */
  secureLink: string | null;
}

export interface WhatsAppTemplateSpec {
  /** Proposed Meta-approved template name (see docs). */
  metaName: string;
  /** BCP-47-ish Meta language code for the proposed template. */
  language: string;
  /** True when the template needs a secure link parameter. */
  requiresSecureLink: boolean;
  /** Ordered {{1}}…{{n}} body parameter values. */
  parameters(ctx: WhatsAppTemplateContext): string[];
}

/** Internal template ids beyond the callout invitation. */
export const WHATSAPP_TEMPLATE_IDS = {
  CALLOUT_UPDATE: "callout_update",
  CALLOUT_CANCELLATION: "callout_cancellation",
  TRAINING_REMINDER: "training_reminder",
  ADMIN_NOTICE: "admin_notice",
} as const;

/**
 * WhatsApp body parameters reject newlines, tabs, and runs of >4
 * spaces; operational free-text must be flattened and bounded before
 * it can reach a template. Empty results are a caller bug and throw —
 * an empty parameter would fail at Meta anyway, and failing here
 * keeps the attempt honest.
 */
function sanitizeParameter(value: string, maxLength = 240): string {
  const cleaned = value
    .replace(/[\n\t]/g, " ")
    .replace(/ {4,}/g, "   ")
    .trim()
    .slice(0, maxLength);
  if (!cleaned) {
    throw new Error("WhatsApp template parameter resolved to empty text.");
  }
  return cleaned;
}

function required(ctx: WhatsAppTemplateContext, value: string | null): string {
  if (value == null) {
    throw new Error(
      "WhatsApp template requires a parameter that was not resolved.",
    );
  }
  return sanitizeParameter(value);
}

export const WHATSAPP_TEMPLATES: Record<string, WhatsAppTemplateSpec> = {
  // Callout alert — "{{1}} is requesting assistance: {{2}}. Respond
  // here: {{3}}"
  [CALLOUT_INVITATION_TEMPLATE]: {
    metaName: "sarbase_callout_alert",
    language: "en",
    requiresSecureLink: true,
    parameters: (ctx) => [
      required(ctx, ctx.organizationName),
      required(ctx, ctx.subject),
      required(ctx, ctx.secureLink),
    ],
  },
  // Callout update — "{{1}} posted an update for: {{2}}."
  [WHATSAPP_TEMPLATE_IDS.CALLOUT_UPDATE]: {
    metaName: "sarbase_callout_update",
    language: "en",
    requiresSecureLink: false,
    parameters: (ctx) => [
      required(ctx, ctx.organizationName),
      required(ctx, ctx.subject),
    ],
  },
  // Callout cancellation — "{{1}} cancelled the callout: {{2}}."
  [WHATSAPP_TEMPLATE_IDS.CALLOUT_CANCELLATION]: {
    metaName: "sarbase_callout_cancellation",
    language: "en",
    requiresSecureLink: false,
    parameters: (ctx) => [
      required(ctx, ctx.organizationName),
      required(ctx, ctx.subject),
    ],
  },
  // Training reminder — "{{1}} reminder: {{2}}."
  [WHATSAPP_TEMPLATE_IDS.TRAINING_REMINDER]: {
    metaName: "sarbase_training_reminder",
    language: "en",
    requiresSecureLink: false,
    parameters: (ctx) => [
      required(ctx, ctx.organizationName),
      required(ctx, ctx.subject),
    ],
  },
  // Administrative notice — "{{1}} needs your attention: {{2}}."
  [WHATSAPP_TEMPLATE_IDS.ADMIN_NOTICE]: {
    metaName: "sarbase_admin_notice",
    language: "en",
    requiresSecureLink: false,
    parameters: (ctx) => [
      required(ctx, ctx.organizationName),
      required(ctx, ctx.subject),
    ],
  },
};

/** The registered spec for an internal template id, or null. */
export function resolveWhatsAppTemplate(
  templateId: string,
): WhatsAppTemplateSpec | null {
  return WHATSAPP_TEMPLATES[templateId] ?? null;
}
