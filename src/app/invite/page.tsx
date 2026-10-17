import {
  getInvitationForToken,
  invitationDisplayState,
} from "@/lib/domain/invitations";
import { tryParseFirebaseClientEnvironment } from "@/lib/env";
import { instantExpiryLabel } from "@/lib/dates";
import { LegalFooter } from "@/components/legal-footer";

import { acceptMemberInvitationAction } from "./actions";
import { InviteAcceptForm } from "./invite-form";

/**
 * Public token-gated member-invitation page.
 *
 * The `?t=` query parameter carries the invitation's bearer token; the
 * server resolves only its SHA-256 hash. A valid, live token exposes
 * exactly the context the invitee needs: the organization name, the
 * member record's display name, the invited role, the destination
 * email, and the expiry — nothing else about the organization.
 *
 * Possession of the link is NOT sufficient to accept: acceptance
 * requires a Firebase sign-in whose VERIFIED email equals the
 * invitation's destination (enforced in acceptMemberInvitationAction).
 *
 * `robots: noindex` keeps tokenized links out of crawlers.
 */
export const metadata = {
  title: "Organization invitation",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

function Card({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto max-w-md px-4 py-10">
      <div className="rounded-lg border border-neutral-200 p-5">{children}</div>
      <LegalFooter className="mt-6 text-center" />
    </main>
  );
}

export default async function InvitePage({
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
          SARbase invitation
        </h1>
        <p className="mt-3 text-sm text-neutral-700">
          This invitation link isn&apos;t valid. It may have been mistyped or
          replaced by a newer one — please use the exact link from your
          invitation email, or ask an administrator to send a new invitation.
        </p>
      </Card>
    );
  }

  const state = invitationDisplayState(invitation);
  if (state !== "pending") {
    return (
      <Card>
        <h1 className="text-xl font-semibold tracking-tight">
          SARbase invitation
        </h1>
        <p className="mt-3 text-sm text-neutral-700">
          {state === "accepted"
            ? "This invitation has already been accepted. Sign in with the account that accepted it."
            : state === "revoked"
              ? "This invitation has been revoked. Ask an administrator to send a new one."
              : "This invitation has expired. Ask an administrator to send a new one."}
        </p>
      </Card>
    );
  }

  const firebaseConfigured = tryParseFirebaseClientEnvironment() !== null;

  return (
    <Card>
      <p className="text-xs font-medium uppercase tracking-wide text-neutral-500">
        {invitation.organization.name}
      </p>
      <h1 className="mt-1 text-xl font-semibold tracking-tight">
        You&apos;re invited to SARbase
      </h1>
      <p className="mt-2 text-sm text-neutral-700">
        <span className="font-medium text-neutral-900">
          {invitation.member.displayName}
        </span>{" "}
        has been invited to join {invitation.organization.name} with{" "}
        {invitation.role === "ADMIN" ? "administrator" : "member"} access.
      </p>
      <p className="mt-2 text-sm text-neutral-600">
        This invitation was sent to{" "}
        <span className="font-medium text-neutral-900">{invitation.email}</span>{" "}
        and expires{" "}
        {instantExpiryLabel(
          invitation.expiresAt,
          invitation.organization.timezone,
        )}
        . Sign in — or create an account — with that email address to accept it.
      </p>

      <div className="mt-5">
        <InviteAcceptForm
          action={acceptMemberInvitationAction.bind(null, token!)}
          invitedEmail={invitation.email}
          configured={firebaseConfigured}
        />
      </div>
    </Card>
  );
}
