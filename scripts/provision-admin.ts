import { PrismaClient } from "@prisma/client";

/**
 * Bootstrap/grant organization administrator access — the ONLY way the
 * first admin comes into being. There is deliberately no in-app or
 * self-registration path to ADMIN.
 *
 * Usage:
 *   tsx --env-file-if-exists=.env scripts/provision-admin.ts \
 *     --org "My SAR Organization" [--create] (--uid <firebaseUid> | --email <identityEmail>)
 *
 * Semantics:
 * - --org names an existing organization (id or exact name); --create
 *   makes it if missing (idempotent by name).
 * - --uid grants ADMIN to the AuthIdentity for that Firebase UID,
 *   creating the AuthIdentity if the person has not signed in yet.
 * - --email grants ADMIN to an EXISTING AuthIdentity whose sign-in email
 *   matches (i.e. the person has signed in at least once). It never
 *   creates an identity — SARbase does not guess a Firebase UID from an
 *   email, and access is never granted by email matching alone.
 * - Idempotent: re-running reconciles to "identity has ADMIN role in
 *   the org" and reports what changed.
 *
 * This is a normal provisioning command, safe to commit — it contains
 * no credentials; the operator supplies the org and identity selectors.
 */
interface ProvisionArgs {
  org: string;
  create: boolean;
  uid?: string;
  email?: string;
}

export function parseProvisionArgs(argv: string[]): ProvisionArgs {
  const args: Partial<ProvisionArgs> = { create: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    switch (flag) {
      case "--org":
        args.org = value;
        i += 1;
        break;
      case "--uid":
        args.uid = value;
        i += 1;
        break;
      case "--email":
        args.email = value;
        i += 1;
        break;
      case "--create":
        args.create = true;
        break;
      default:
        throw new Error(`Unknown argument: ${flag}`);
    }
  }
  if (!args.org) {
    throw new Error("--org <name-or-id> is required");
  }
  if (!args.uid && !args.email) {
    throw new Error(
      "one of --uid <firebaseUid> or --email <email> is required",
    );
  }
  if (args.uid && args.email) {
    throw new Error("pass --uid OR --email, not both");
  }
  return args as ProvisionArgs;
}

async function main() {
  const args = parseProvisionArgs(process.argv.slice(2));
  const prisma = new PrismaClient();
  try {
    // Resolve the organization: id first, then exact name match.
    let organization =
      (await prisma.organization.findUnique({ where: { id: args.org } })) ??
      (await prisma.organization.findFirst({ where: { name: args.org } }));
    if (!organization) {
      if (!args.create) {
        throw new Error(
          `Organization "${args.org}" not found. Pass --create to create it.`,
        );
      }
      organization = await prisma.organization.create({
        data: { name: args.org },
      });
      console.log(`Created organization "${organization.name}".`);
    }

    // Resolve the login identity.
    let identity:
      | {
          id: string;
          email: string | null;
          providerUid: string;
          status: "ACTIVE" | "DISABLED";
        }
      | undefined;
    if (args.uid) {
      identity = await prisma.authIdentity.upsert({
        where: {
          provider_providerUid: { provider: "firebase", providerUid: args.uid },
        },
        update: {},
        create: { provider: "firebase", providerUid: args.uid },
      });
      console.log(`Identity ready (firebase uid ${args.uid}).`);
    } else {
      const email = args.email!.toLowerCase().trim();
      const matches = await prisma.authIdentity.findMany({
        where: { email },
      });
      if (matches.length === 0) {
        throw new Error(
          `No AuthIdentity with email ${email}. Have the person sign in ` +
            `once (so their identity is provisioned), then re-run — or ` +
            `use --uid with their Firebase UID.`,
        );
      }
      if (matches.length > 1) {
        throw new Error(
          `${matches.length} AuthIdentity rows share email ${email}; ` +
            `use --uid to disambiguate.`,
        );
      }
      identity = matches[0];
    }
    if (!identity) {
      throw new Error("Could not resolve an AuthIdentity.");
    }

    if (identity.status !== "ACTIVE") {
      throw new Error(
        `Identity ${identity.id} is ${identity.status} — refusing to grant access.`,
      );
    }

    const access = await prisma.organizationAccess.upsert({
      where: {
        authIdentityId_organizationId: {
          authIdentityId: identity.id,
          organizationId: organization.id,
        },
      },
      update: { role: "ADMIN" },
      create: {
        authIdentityId: identity.id,
        organizationId: organization.id,
        role: "ADMIN",
      },
    });
    console.log(
      `${identity.email ?? identity.providerUid} now has ADMIN access to "${organization.name}" (access id ${access.id}).`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

if (process.env.VITEST !== "true") {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
