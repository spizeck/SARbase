import {
  getInvitationForToken,
  CALLOUT_RESPONSE_LABELS,
} from "@/lib/domain/callouts";
import { relativeTimeLabel } from "@/lib/dates";

import { respondToCalloutTokenAction } from "./actions";
import { TokenResponseForm } from "./response-form";

/**
 * Public token-gated callout response page (issue #14).
 *
 * The `?t=` query parameter carries the invitee's 256-bit opaque
 * response token; the server resolves only its SHA-256 hash. A valid
 * token exposes exactly one invitation: the member's own name, the
 * callout title/message, and their own response — never other
 * invitees, counts, or organization internals. Invalid tokens get a
 * single opaque "not valid" page with no existence signal.
 *
 * `robots: noindex` keeps tokenized links out of crawlers.
 */
export const metadata = {
  title: "Callout response",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

function Card({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto max-w-md px-4 py-10">
      <div className="rounded-lg border border-neutral-200 p-5">{children}</div>
    </main>
  );
}

export default async function RespondPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { t } = await searchParams;
  const token = typeof t === "string" ? t : null;
  const invitation = token ? await getInvitationForToken(token) : null;

  if (!invitation) {
    return (
      <Card>
        <h1 className="text-xl font-semibold tracking-tight">
          SARbase callout
        </h1>
        <p className="mt-3 text-sm text-neutral-700">
          This response link isn&apos;t valid. It may have been mistyped —
          please use the exact link from your notification email, or ask your
          coordinator to record your response.
        </p>
      </Card>
    );
  }

  const { callout } = invitation;
  const closed = callout.status !== "ACTIVE";

  return (
    <Card>
      <p className="text-xs font-medium uppercase tracking-wide text-neutral-500">
        {callout.organization.name} — Callout
      </p>
      <h1 className="mt-1 text-xl font-semibold tracking-tight">
        {callout.title}
      </h1>
      {callout.message && (
        <p className="mt-2 whitespace-pre-line text-sm text-neutral-700">
          {callout.message}
        </p>
      )}

      <p className="mt-4 text-sm text-neutral-600">
        Responding for{" "}
        <span className="font-medium text-neutral-900">
          {invitation.member.displayName}
        </span>
      </p>

      {invitation.response && (
        <p className="mt-2 text-sm text-neutral-700">
          Your current response:{" "}
          <span className="font-medium">
            {CALLOUT_RESPONSE_LABELS[invitation.response]}
          </span>
          {invitation.respondedAt && (
            <span className="text-neutral-500">
              {" "}
              · {relativeTimeLabel(invitation.respondedAt)}
            </span>
          )}
        </p>
      )}

      {closed ? (
        <p className="mt-4 rounded-md border border-neutral-200 bg-neutral-50 p-3 text-sm text-neutral-700">
          This callout is closed and no longer accepts responses.
        </p>
      ) : (
        <div className="mt-5">
          <TokenResponseForm
            action={respondToCalloutTokenAction.bind(null, token!)}
            currentResponse={invitation.response}
          />
          <p className="mt-3 text-xs text-neutral-500">
            You can change your response while this callout is active.
          </p>
        </div>
      )}
    </Card>
  );
}
