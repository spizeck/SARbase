import { notFound, redirect } from "next/navigation";

import { log } from "@/lib/logging";
import { prisma } from "@/lib/prisma";

import {
  AuthenticationError,
  AuthorizationError,
  getAuthContext,
  type AuthContext,
} from "./context";

/**
 * Centralized server-side authorization for the authenticated surface.
 *
 * THE RULE: an organizationId/memberId/unitId arriving from a URL, form,
 * server-action binding, hidden input, or query parameter is an
 * UNTRUSTED SELECTOR. Authorization is always derived here — from the
 * verified session's OrganizationAccess rows — never from the supplied
 * id itself. For member/unit targets the real organizationId is
 * resolved from the record, then checked against the caller's grants.
 *
 * Every helper fails closed; every denial is logged without PII.
 * Pages use the `*OrNotFound` variants so inaccessible resources are
 * indistinguishable from nonexistent ones (no existence disclosure).
 * Actions let the typed errors propagate to mapDomainError/ActionState
 * mapping which returns the same opaque "not found" message.
 */

function logDenial(event: string, ctx: AuthContext | null, detail?: object) {
  log({
    event,
    level: "warn",
    outcome: "expected_failure",
    subsystem: "authz",
    actorId: ctx?.identity.id,
    ...detail,
  });
}

/**
 * Require any authenticated, ACTIVE identity. Pages should use the
 * redirecting default; actions can catch AuthenticationError.
 */
export async function requireAuth(): Promise<AuthContext> {
  const ctx = await getAuthContext();
  if (!ctx) {
    redirect("/login");
  }
  return ctx;
}

/** Non-redirecting variant for actions/tests. */
export async function getAuthContextOrThrow(): Promise<AuthContext> {
  const ctx = await getAuthContext();
  if (!ctx) {
    throw new AuthenticationError("unauthenticated");
  }
  return ctx;
}

export function isOrgAdmin(ctx: AuthContext, organizationId: string): boolean {
  return ctx.access.some(
    (a) => a.organizationId === organizationId && a.role === "ADMIN",
  );
}

export function hasOrgAccess(
  ctx: AuthContext,
  organizationId: string,
): boolean {
  return ctx.access.some((a) => a.organizationId === organizationId);
}

/** Organizations this identity administers — for listing scoping. */
export function adminOrganizationIds(ctx: AuthContext): string[] {
  return ctx.access
    .filter((a) => a.role === "ADMIN")
    .map((a) => a.organizationId);
}

/**
 * Require ADMIN access to the given organization. `organizationId` is
 * still an untrusted selector — it only selects WHICH grant must exist.
 */
export function requireOrgAdmin(
  ctx: AuthContext,
  organizationId: string,
): void {
  if (!isOrgAdmin(ctx, organizationId)) {
    logDenial("authz.org_admin_denied", ctx, { organizationId });
    throw new AuthorizationError();
  }
}

export function requireOrgAccess(
  ctx: AuthContext,
  organizationId: string,
): void {
  if (!hasOrgAccess(ctx, organizationId)) {
    logDenial("authz.org_access_denied", ctx, { organizationId });
    throw new AuthorizationError();
  }
}

/** notFound() variant for pages — no existence disclosure. */
export async function requireOrgAdminOrNotFound(
  organizationId: string,
): Promise<AuthContext> {
  const ctx = await requireAuth();
  if (!isOrgAdmin(ctx, organizationId)) {
    logDenial("authz.org_admin_denied", ctx, { organizationId });
    notFound();
  }
  return ctx;
}

/**
 * Resolve a Member by the caller-supplied id, derive its REAL
 * organizationId from the record, and require ADMIN access to that
 * org. The supplied organizationId (if any) is never consulted.
 */
export async function requireOrgAdminForMember(
  ctx: AuthContext,
  memberId: string,
) {
  const member = await prisma.member.findUnique({
    where: { id: memberId },
  });
  if (!member || !isOrgAdmin(ctx, member.organizationId)) {
    logDenial("authz.member_scope_denied", ctx, { entityId: memberId });
    throw new AuthorizationError();
  }
  return member;
}

export async function requireOrgAdminForUnit(ctx: AuthContext, unitId: string) {
  const unit = await prisma.unit.findUnique({ where: { id: unitId } });
  if (!unit || !isOrgAdmin(ctx, unit.organizationId)) {
    logDenial("authz.unit_scope_denied", ctx, { entityId: unitId });
    throw new AuthorizationError();
  }
  return unit;
}

/**
 * QualificationDefinition/MemberQualification lookups — same rule: the
 * caller-supplied id selects the record; the record's own
 * organizationId (denormalized + composite-FK-guaranteed on
 * MemberQualification) decides which grant must exist.
 */
export async function requireOrgAdminForDefinition(
  ctx: AuthContext,
  definitionId: string,
) {
  const definition = await prisma.qualificationDefinition.findUnique({
    where: { id: definitionId },
  });
  if (!definition || !isOrgAdmin(ctx, definition.organizationId)) {
    logDenial("authz.definition_scope_denied", ctx, { entityId: definitionId });
    throw new AuthorizationError();
  }
  return definition;
}

export async function requireOrgAdminForQualification(
  ctx: AuthContext,
  qualificationId: string,
) {
  const record = await prisma.memberQualification.findUnique({
    where: { id: qualificationId },
  });
  if (!record || !isOrgAdmin(ctx, record.organizationId)) {
    logDenial("authz.qualification_scope_denied", ctx, {
      entityId: qualificationId,
    });
    throw new AuthorizationError();
  }
  return record;
}
