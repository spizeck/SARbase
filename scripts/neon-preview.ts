/**
 * Neon preview-branch lifecycle for pull requests. Implements model A
 * of the app-foundations database-lifecycle standard (ADR-0001,
 * standards/database-lifecycle.md); adapted from the-bottom-line's
 * reference implementation.
 *
 * Subcommands:
 *   provision — verify the Neon branch created for this PR (created by
 *     neondatabase/create-branch-action in the workflow), prove it is a
 *     child of the permanent `testing` branch, then write the pooled /
 *     unpooled connection URLs as git-branch-scoped Vercel env vars so
 *     the PR's preview deployments see them. Optionally triggers a
 *     fresh Vercel deployment for the head SHA (needed on opened /
 *     reopened, where the only existing deployment predates the env
 *     vars).
 *   teardown — on PR close/merge, delete ONLY the `preview/pr-<n>`
 *     Neon branch (idempotent) and remove the branch-scoped Vercel env
 *     vars. Permanent branches (`main`, `testing`, primary, protected)
 *     can never be deleted by this path.
 *   gate — provisioning policy check. Runs BEFORE the branch-creation
 *     step and emits `provision=true|false` to $GITHUB_OUTPUT. Every
 *     same-repo, non-Dependabot open PR is eligible automatically —
 *     no label required. Denies Dependabot-authored PRs outright,
 *     fork PRs, and PRs that are not open.
 *   reconcile — scheduled sweep: renew the expiration on `preview/pr-*`
 *     branches whose PR is still open (the heartbeat that keeps quiet
 *     long-lived PRs' databases alive), and report `preview/pr-*`
 *     branches whose PR is no longer open. Deletion reporting is
 *     dry-run only — deletion requires DRY_RUN=false, which the
 *     workflow only allows on manual dispatch.
 *
 * Branch expiration: every preview branch carries an `expires_at` TTL
 * (PREVIEW_BRANCH_TTL_MS, 14 days) — stamped during provisioning and
 * renewed on every provision and weekly reconcile while its PR is
 * open. TTL is
 * the backstop for missed teardowns; reconcile's weekly renewal keeps
 * quiet open PRs alive (TTL >> sweep interval gives every open branch
 * two renewal chances before expiry). Permanent branches (main,
 * testing) can never receive an expiry — setBranchExpiration refuses
 * non-preview names.
 *
 * Safety invariants enforced here, not just in YAML:
 *   - preview branches must match `preview/pr-<digits>` exactly;
 *   - a preview branch's parent must be the `testing` branch;
 *   - primary/protected branches and `main`/`testing` are never
 *     deleted and never receive an expiry;
 *   - Dependabot PRs can never provision, no matter which code path is
 *     taken;
 *   - no credential is ever printed — URLs are masked before first use.
 */

import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { normalizeDatabaseEndpoint } from "../src/lib/env";

const TAG = "[neon-preview]";
const NEON_API = "https://console.neon.tech/api/v2";
const VERCEL_API = "https://api.vercel.com";

export type Fetcher = typeof fetch;
export type Env = Record<string, string | undefined>;

const PREVIEW_BRANCH_RE = /^preview\/pr-(\d+)$/;

/** PR authors that are never allowed a preview database. */
const DENIED_PROVISIONING_AUTHORS = new Set(["dependabot[bot]"]);

/**
 * Minimum age of a PR closure before reconcile will delete its preview
 * branch. Absorbs close→reopen races and any trailing automation on a
 * just-closed PR. On a weekly sweep an extra hour is free.
 */
const RECONCILE_CLOSE_GRACE_MS = 60 * 60 * 1000;

/**
 * Lifetime of a preview branch between renewals. Renewed at creation,
 * on every provision (push/reopen), and by the weekly reconcile for
 * branches whose PR is still open — so a quiet long-lived PR's
 * database survives, while a leaked branch (missed teardown) still
 * self-deletes within ~2 weeks even if every cleanup path fails.
 */
const PREVIEW_BRANCH_TTL_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * RFC 3339 expiry timestamp `PREVIEW_BRANCH_TTL_MS` from now, used by
 * every TTL stamp/renewal (Neon's 30-day ceiling leaves ample room).
 */
export function previewBranchExpiry(now: number = Date.now()): string {
  return new Date(now + PREVIEW_BRANCH_TTL_MS).toISOString();
}

const PREVIEW_ENV_KEYS = [
  "DATABASE_URL",
  "DATABASE_URL_UNPOOLED",
  "APP_PREVIEW_DB_HOST",
] as const;

type NeonBranch = {
  id: string;
  name: string;
  parent_id?: string;
  primary?: boolean;
  protected?: boolean;
};

function fail(message: string): never {
  console.error(`${TAG} ${message}`);
  process.exitCode = 1;
  throw new Error(message);
}

function requireEnv(env: Env, keys: string[]): void {
  const missing = keys.filter((k) => !env[k]);
  if (missing.length) {
    fail(`missing required environment: ${missing.join(", ")}`);
  }
}

function mask(value: string): void {
  console.log(`::add-mask::${value}`);
}

function canonicalHost(url: string): string | null {
  try {
    return normalizeDatabaseEndpoint(new URL(url).hostname);
  } catch {
    return null;
  }
}

// --- API clients -----------------------------------------------------------

async function neon(
  env: Env,
  fetcher: Fetcher,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  return fetcher(`${NEON_API}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${env.NEON_API_KEY}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

async function neonJson<T>(
  env: Env,
  fetcher: Fetcher,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const res = await neon(env, fetcher, path, init);
  if (!res.ok) {
    fail(`Neon API ${init?.method ?? "GET"} ${path} -> ${res.status}`);
  }
  return (await res.json()) as T;
}

async function vercel(
  env: Env,
  fetcher: Fetcher,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const sep = path.includes("?") ? "&" : "?";
  return fetcher(`${VERCEL_API}${path}${sep}teamId=${env.VERCEL_TEAM_ID}`, {
    ...init,
    headers: {
      authorization: `Bearer ${env.VERCEL_TOKEN}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

async function vercelJson<T>(
  env: Env,
  fetcher: Fetcher,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const res = await vercel(env, fetcher, path, init);
  if (!res.ok) {
    fail(`Vercel API ${init?.method ?? "GET"} ${path} -> ${res.status}`);
  }
  return (await res.json()) as T;
}

async function github<T>(
  env: Env,
  fetcher: Fetcher,
  path: string,
): Promise<T | null> {
  let res: Response;
  try {
    res = await fetcher(`https://api.github.com${path}`, {
      headers: {
        authorization: `Bearer ${env.GITHUB_TOKEN}`,
        accept: "application/vnd.github+json",
      },
    });
  } catch {
    console.warn(
      `${TAG} GitHub API GET ${path} failed — treating as unverifiable`,
    );
    return null;
  }
  if (!res.ok) {
    console.warn(
      `${TAG} GitHub API GET ${path} -> ${res.status} — treating as unverifiable`,
    );
    return null;
  }
  try {
    return (await res.json()) as T;
  } catch {
    console.warn(
      `${TAG} GitHub API GET ${path} returned unparseable JSON — treating as unverifiable`,
    );
    return null;
  }
}

// --- Neon helpers ----------------------------------------------------------

async function listBranches(env: Env, fetcher: Fetcher): Promise<NeonBranch[]> {
  const data = await neonJson<{ branches: NeonBranch[] }>(
    env,
    fetcher,
    `/projects/${env.NEON_PROJECT_ID}/branches`,
  );
  return data.branches;
}

async function findBranchByName(
  env: Env,
  fetcher: Fetcher,
  name: string,
): Promise<NeonBranch | null> {
  return (
    (await listBranches(env, fetcher)).find((b) => b.name === name) ?? null
  );
}

/**
 * Delete `preview/pr-<n>` — and only that shape — with permanent-branch
 * guards. Idempotent: an absent branch logs and returns. A branch that
 * does not descend from the expected parent (`testing`) is refused.
 */
export async function deletePreviewBranch(
  env: Env,
  fetcher: Fetcher,
  branchName: string,
  opts?: { dryRun?: boolean },
): Promise<boolean> {
  if (!PREVIEW_BRANCH_RE.test(branchName)) {
    fail(
      `refusing to delete ${JSON.stringify(branchName)} — only preview/pr-<number> branches may be deleted`,
    );
  }
  const branches = await listBranches(env, fetcher);
  const branch = branches.find((b) => b.name === branchName);
  if (!branch) {
    console.log(`${TAG} ${branchName} absent — nothing to delete`);
    return false;
  }
  const parentName = env.NEON_PARENT_BRANCH ?? "testing";
  const parent = branches.find((b) => b.id === branch.parent_id);
  if (branch.primary || branch.protected) {
    fail(
      `refusing to delete ${branch.name} — branch is ${branch.primary ? "primary" : "protected"}`,
    );
  }
  if (!parent || parent.name !== parentName) {
    fail(
      `refusing to delete ${branch.name} — parent is ${parent?.name ?? "unknown"}, expected ${parentName}`,
    );
  }
  if (opts?.dryRun) {
    console.log(
      `${TAG} [dry-run] would delete Neon branch ${branchName} (${branch.id})`,
    );
    return true;
  }
  const res = await neon(
    env,
    fetcher,
    `/projects/${env.NEON_PROJECT_ID}/branches/${branch.id}`,
    { method: "DELETE" },
  );
  if (!res.ok && res.status !== 404) {
    fail(`Neon DELETE branch ${branch.id} -> ${res.status}`);
  }
  console.log(`${TAG} deleted Neon branch ${branchName} (${branch.id})`);
  return true;
}

/**
 * Set or renew a preview branch's `expires_at`. Only ever applied to
 * `preview/pr-<n>` branches — a permanent branch must never carry a
 * TTL, so the name check is a hard fail, not a skip.
 *
 * API failures are non-fatal (warn + false): branch expiration is an
 * Early Access feature and the account may not have it, in which case
 * teardown and reconcile still provide complete cleanup — TTL is a
 * bonus safety net, never the primary mechanism.
 */
export async function setBranchExpiration(
  env: Env,
  fetcher: Fetcher,
  branch: NeonBranch,
): Promise<boolean> {
  if (!PREVIEW_BRANCH_RE.test(branch.name)) {
    fail(
      `refusing to set expiration on ${JSON.stringify(branch.name)} — only preview/pr-<number> branches may expire`,
    );
  }
  const expiresAt = previewBranchExpiry();
  const res = await neon(
    env,
    fetcher,
    `/projects/${env.NEON_PROJECT_ID}/branches/${branch.id}`,
    {
      method: "PATCH",
      body: JSON.stringify({ branch: { expires_at: expiresAt } }),
    },
  );
  if (!res.ok) {
    console.warn(
      `${TAG} ${branch.name} expires_at update failed (${res.status}) — ` +
        `branch expiration may be unavailable (Early Access feature); ` +
        `teardown/reconcile cleanup is unaffected`,
    );
    return false;
  }
  console.log(`${TAG} ${branch.name} expiration set to ${expiresAt}`);
  return true;
}

// --- Vercel helpers --------------------------------------------------------

type VercelEnv = {
  id?: string;
  key: string;
  target?: string[];
  gitBranch?: string | null;
};

async function upsertBranchEnv(
  env: Env,
  fetcher: Fetcher,
  key: string,
  value: string,
  gitBranch: string,
): Promise<void> {
  await vercelJson(
    env,
    fetcher,
    `/v10/projects/${env.VERCEL_PROJECT_ID}/env?upsert=true`,
    {
      method: "POST",
      body: JSON.stringify({
        key,
        value,
        type: "sensitive",
        target: ["preview"],
        gitBranch,
      }),
    },
  );
  console.log(`${TAG} upserted Vercel env ${key} (preview, ${gitBranch})`);
}

type VercelEnvPage = {
  envs?: VercelEnv[];
  pagination?: { next?: number | string | null };
};

/**
 * All preview env vars scoped to `gitBranch`, following pagination if
 * the API returns it. `pagination.next` is Vercel's standard timestamp
 * cursor (`?since=`); a missing or non-advancing cursor ends the loop,
 * so a single-page response costs exactly one request.
 */
async function listBranchEnvs(
  env: Env,
  fetcher: Fetcher,
  gitBranch: string,
): Promise<VercelEnv[]> {
  const all: VercelEnv[] = [];
  let since: string | null = null;
  const seen = new Set<string>();
  for (;;) {
    const params = new URLSearchParams({ gitBranch });
    if (since) params.set("since", since);
    const data = await vercelJson<VercelEnvPage>(
      env,
      fetcher,
      `/v9/projects/${env.VERCEL_PROJECT_ID}/env?${params}`,
    );
    all.push(...(data.envs ?? []));
    const next = data.pagination?.next;
    const cursor = next === null || next === undefined ? null : String(next);
    if (!cursor || seen.has(cursor)) return all;
    seen.add(cursor);
    since = cursor;
  }
}

async function deleteBranchEnvs(
  env: Env,
  fetcher: Fetcher,
  gitBranch: string,
  opts?: { dryRun?: boolean },
): Promise<void> {
  const stale = (await listBranchEnvs(env, fetcher, gitBranch)).filter(
    (e) =>
      e.gitBranch === gitBranch &&
      (PREVIEW_ENV_KEYS as readonly string[]).includes(e.key) &&
      e.id,
  );
  for (const e of stale) {
    if (opts?.dryRun) {
      console.log(
        `${TAG} [dry-run] would delete Vercel env ${e.key} for ${gitBranch}`,
      );
      continue;
    }
    const res = await vercel(
      env,
      fetcher,
      `/v9/projects/${env.VERCEL_PROJECT_ID}/env/${e.id}`,
      { method: "DELETE" },
    );
    if (!res.ok && res.status !== 404) {
      fail(`Vercel DELETE env ${e.key} (${e.id}) -> ${res.status}`);
    }
    console.log(`${TAG} deleted Vercel env ${e.key} for ${gitBranch}`);
  }
}

async function triggerDeployment(env: Env, fetcher: Fetcher): Promise<void> {
  const [org, repo] = (env.GITHUB_REPOSITORY ?? "").split("/");
  const data = await vercelJson<{ url?: string }>(
    env,
    fetcher,
    "/v13/deployments",
    {
      method: "POST",
      body: JSON.stringify({
        name: env.VERCEL_PROJECT_NAME,
        project: env.VERCEL_PROJECT_ID,
        gitSource: {
          type: "github",
          org,
          repo,
          ref: env.PR_HEAD_SHA,
        },
        meta: { previewDbBranch: env.PREVIEW_BRANCH_NAME },
      }),
    },
  );
  console.log(`${TAG} triggered preview deployment: ${data.url ?? "(no url)"}`);
}

/**
 * Preview env hygiene check (non-blocking). Preview deployments must
 * never carry FIREBASE_ADMIN_* — those credentials act on the
 * production user base, and application code cannot prevent
 * same-deployment code from reading an env var that exists. The
 * runtime guard (parseFirebaseAdminEnvironment in src/lib/env.ts)
 * fails closed, but a visible warning here surfaces the
 * misconfiguration before someone wonders why preview auth is broken.
 * Values are never fetched or printed — key names only.
 */
async function warnOnPreviewAdminCredentials(
  env: Env,
  fetcher: Fetcher,
): Promise<void> {
  const flag = "ALLOW_FIREBASE_ADMIN_IN_PREVIEW";
  try {
    const data = await vercelJson<{ envs?: VercelEnv[] }>(
      env,
      fetcher,
      `/v9/projects/${env.VERCEL_PROJECT_ID}/env`,
    );
    const previewScoped = (data.envs ?? []).filter((e) =>
      (e.target ?? []).includes("preview"),
    );
    const previewKeys = new Set(
      previewScoped
        .filter((e) => e.key.startsWith("FIREBASE_ADMIN_"))
        .map((e) => e.key),
    );
    const flagSet = previewScoped.some((e) => e.key === flag);
    if (previewKeys.size > 0 && !flagSet) {
      console.warn(
        `${TAG} WARNING: Vercel Preview environment carries ` +
          `${[...previewKeys].sort().join(", ")} without ${flag} — ` +
          `the Admin SDK will refuse to initialize on every preview ` +
          `deployment. Remove them, or set ${flag}=true deliberately.`,
      );
    }
  } catch (error) {
    console.warn(
      `${TAG} preview env hygiene check failed (non-blocking): ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Open same-repo PRs sharing one git head branch — excluding `excludePr`.
 * Vercel env vars are scoped per GIT BRANCH, not per PR, so two open
 * PRs from the same head ref collide: provisioning the second would
 * overwrite the first's database URLs, and tearing down the first
 * would strip the second's vars. Returns null when GitHub cannot be
 * asked (token absent or lookup failed) — callers decide how strict
 * unverifiability is for their own write.
 */
async function openPrsWithRef(
  env: Env,
  fetcher: Fetcher,
  gitBranch: string,
  excludePr?: number,
): Promise<number[] | null> {
  if (!env.GITHUB_TOKEN || !env.GITHUB_REPOSITORY) {
    return null;
  }
  const owner = env.GITHUB_REPOSITORY.split("/")[0];
  const prs = await github<{ number: number; head: { ref: string } }[]>(
    env,
    fetcher,
    `/repos/${env.GITHUB_REPOSITORY}/pulls?state=open&head=${owner}:${encodeURIComponent(gitBranch)}&per_page=100`,
  );
  if (!prs) {
    return null;
  }
  return prs
    .filter((p) => p.head.ref === gitBranch && p.number !== excludePr)
    .map((p) => p.number);
}

// --- Provisioning policy -----------------------------------------------------

export type ProvisioningContext = {
  authorLogin: string | undefined;
  headRepo: string | undefined;
  repo: string | undefined;
  state?: string | undefined;
  /** github.event.pull_request.base.ref — the branch the PR targets. */
  baseRef?: string | undefined;
  /** github.event.repository.default_branch — the trusted base. */
  defaultBranch?: string | undefined;
};

/**
 * Whether this PR may be given a preview Neon branch. Evaluated from
 * event context the workflow passes in — never from PR-controlled code.
 * Deny-by-default: every eligible PR (same-repo, non-Dependabot, open)
 * is provisioned automatically.
 */
export function provisioningDecision(ctx: ProvisioningContext): {
  allow: boolean;
  reason: string;
} {
  // Absolute: Dependabot PRs are never provisioned, whatever label,
  // title, or branch name they carry. (Dependabot branches are
  // same-repo, so the fork check alone does NOT catch them.)
  if (
    ctx.authorLogin &&
    DENIED_PROVISIONING_AUTHORS.has(ctx.authorLogin.toLowerCase())
  ) {
    return {
      allow: false,
      reason: `${ctx.authorLogin} is a denied author — Dependabot PRs never get preview databases`,
    };
  }
  if (!ctx.headRepo || !ctx.repo || ctx.headRepo !== ctx.repo) {
    return {
      allow: false,
      reason: `head repo ${ctx.headRepo ?? "?"} does not match ${ctx.repo ?? "?"} — fork PRs are never provisioned`,
    };
  }
  // Trusted-base requirement: preview databases only exist for PRs
  // targeting the repository's default branch. A non-default base can
  // be unmerged contributor code — and preview databases are
  // meaningless for stacked/PR-to-PR work anyway.
  if (!ctx.baseRef || !ctx.defaultBranch || ctx.baseRef !== ctx.defaultBranch) {
    return {
      allow: false,
      reason:
        `PR targets base ${ctx.baseRef ?? "?"}, not the default branch ` +
        `${ctx.defaultBranch ?? "?"} — preview databases only provision ` +
        `for default-branch PRs`,
    };
  }
  // A non-open PR must not (re)create a branch — e.g. a trailing event
  // arriving after teardown deleted the branch.
  if (ctx.state !== undefined && ctx.state !== "open") {
    return {
      allow: false,
      reason: `PR state is ${JSON.stringify(ctx.state)}, not open — closed/merged PRs never get a new preview database`,
    };
  }
  return {
    allow: true,
    reason: "eligible same-repo PR — preview databases are automatic",
  };
}

// --- Subcommands -----------------------------------------------------------

/**
 * Policy gate run before any branch creation. Emits `provision=…` to
 * $GITHUB_OUTPUT so later steps can skip; a deny is a normal skip, not
 * a job failure (a Dependabot PR is not "broken").
 */
export async function gate(env: Env): Promise<void> {
  requireEnv(env, [
    "PR_AUTHOR_LOGIN",
    "PR_HEAD_REPO",
    "PR_BASE_REF",
    "DEFAULT_BRANCH",
    "GITHUB_REPOSITORY",
  ]);
  const decision = provisioningDecision({
    authorLogin: env.PR_AUTHOR_LOGIN,
    headRepo: env.PR_HEAD_REPO,
    repo: env.GITHUB_REPOSITORY,
    state: env.PR_STATE,
    baseRef: env.PR_BASE_REF,
    defaultBranch: env.DEFAULT_BRANCH,
  });
  console.log(
    `${TAG} provisioning ${decision.allow ? "allowed" : "skipped"}: ${decision.reason}`,
  );
  if (env.GITHUB_OUTPUT) {
    appendFileSync(env.GITHUB_OUTPUT, `provision=${decision.allow}\n`);
  }
}

export async function provision(env: Env, fetcher: Fetcher): Promise<void> {
  // Defense in depth: when PR context is present, enforce the same
  // policy the `gate` step applies — a denied PR must not reach
  // provider APIs through any path.
  if (env.PR_AUTHOR_LOGIN !== undefined) {
    const decision = provisioningDecision({
      authorLogin: env.PR_AUTHOR_LOGIN,
      headRepo: env.PR_HEAD_REPO,
      repo: env.GITHUB_REPOSITORY,
      state: env.PR_STATE,
      baseRef: env.PR_BASE_REF,
      defaultBranch: env.DEFAULT_BRANCH,
    });
    if (!decision.allow) {
      fail(`provisioning refused by policy: ${decision.reason}`);
    }
  }
  requireEnv(env, [
    "NEON_API_KEY",
    "NEON_PROJECT_ID",
    "NEON_BRANCH_ID",
    "NEON_DB_URL",
    "NEON_DB_URL_POOLED",
    "NEON_DB_HOST",
    "NEON_DB_HOST_POOLED",
    "PREVIEW_BRANCH_NAME",
    "PREVIEW_GIT_BRANCH",
    "VERCEL_TOKEN",
    "VERCEL_TEAM_ID",
    "VERCEL_PROJECT_ID",
    "VERCEL_PROJECT_NAME",
  ]);
  // Mask before anything else can echo these values.
  mask(env.NEON_DB_URL!);
  mask(env.NEON_DB_URL_POOLED!);

  const parent = env.NEON_PARENT_BRANCH ?? "testing";
  const branchName = env.PREVIEW_BRANCH_NAME!;
  if (!PREVIEW_BRANCH_RE.test(branchName)) {
    fail(
      `branch name ${JSON.stringify(branchName)} does not match preview/pr-<number>`,
    );
  }

  // Positive identity: the branch the action resolved must be exactly
  // the expected preview branch and must be a child of `testing`.
  const expectedParent = await findBranchByName(env, fetcher, parent);
  if (!expectedParent) {
    fail(
      `permanent parent branch ${JSON.stringify(parent)} not found in Neon project — refusing to provision`,
    );
  }
  const branch = await neonJson<{ branch: NeonBranch } | NeonBranch>(
    env,
    fetcher,
    `/projects/${env.NEON_PROJECT_ID}/branches/${env.NEON_BRANCH_ID}`,
  );
  const resolved = "branch" in branch ? branch.branch : branch;
  if (resolved.name !== branchName) {
    fail(`Neon branch id resolves to ${resolved.name}, expected ${branchName}`);
  }
  if (resolved.parent_id !== expectedParent.id) {
    fail(
      `${branchName} is not a child of ${parent} (parent_id ${resolved.parent_id ?? "none"} vs ${expectedParent.id}) — refusing to provision`,
    );
  }
  console.log(`${TAG} verified ${branchName} is a child of ${parent}`);

  // Stamp/renew the TTL as soon as the branch is verified a preview
  // child of `testing` — before the refusal checks below, so even a
  // provision that is later refused (e.g. shared-head-ref collision)
  // leaves the branch self-expiring rather than immortal. Non-fatal:
  // a Neon API failure degrades to teardown/reconcile cleanup.
  await setBranchExpiration(env, fetcher, resolved);

  // The connection strings must belong to the verified branch endpoint.
  const pooledHost = canonicalHost(env.NEON_DB_URL_POOLED!);
  const directHost = canonicalHost(env.NEON_DB_URL!);
  const expectedHost = normalizeDatabaseEndpoint(env.NEON_DB_HOST_POOLED!);
  const expectedDirectHost = normalizeDatabaseEndpoint(env.NEON_DB_HOST!);
  if (
    !pooledHost ||
    !directHost ||
    pooledHost !== expectedHost ||
    directHost !== expectedDirectHost ||
    pooledHost !== directHost
  ) {
    fail(
      "database URLs do not resolve to the verified branch endpoint — refusing to write Vercel env vars",
    );
  }

  // Same-git-branch collision: Vercel env vars are scoped per git
  // branch. If another OPEN PR shares this head ref, its vars belong to
  // ITS preview branch — overwriting them would silently repoint that
  // PR's deployments at this database. Refuse; the earlier PR keeps
  // them, and this PR builds without a preview database.
  const prNumber = Number(PREVIEW_BRANCH_RE.exec(branchName)![1]);
  const others = await openPrsWithRef(
    env,
    fetcher,
    env.PREVIEW_GIT_BRANCH!,
    prNumber,
  );
  if (others === null) {
    console.warn(
      `${TAG} could not check for other open PRs on ${env.PREVIEW_GIT_BRANCH} — proceeding (GitHub lookup unavailable)`,
    );
  } else if (others.length > 0) {
    fail(
      `git branch ${env.PREVIEW_GIT_BRANCH} is also the head of open ` +
        `PR(s) ${others.map((n) => `#${n}`).join(", ")} — Vercel preview ` +
        `env vars are scoped per git branch, so provisioning this PR ` +
        `would overwrite that PR's database. Refusing; close or rebase ` +
        `the duplicate PR first.`,
    );
  }

  for (const [key, value] of [
    ["DATABASE_URL", env.NEON_DB_URL_POOLED],
    ["DATABASE_URL_UNPOOLED", env.NEON_DB_URL],
    ["APP_PREVIEW_DB_HOST", env.NEON_DB_HOST_POOLED],
  ] as const) {
    await upsertBranchEnv(env, fetcher, key, value!, env.PREVIEW_GIT_BRANCH!);
  }

  await warnOnPreviewAdminCredentials(env, fetcher);

  if (env.TRIGGER_DEPLOY === "true") {
    requireEnv(env, ["GITHUB_REPOSITORY", "PR_HEAD_SHA"]);
    await triggerDeployment(env, fetcher);
  }
}

export async function teardown(env: Env, fetcher: Fetcher): Promise<void> {
  requireEnv(env, [
    "NEON_API_KEY",
    "NEON_PROJECT_ID",
    "PREVIEW_BRANCH_NAME",
    "VERCEL_TOKEN",
    "VERCEL_TEAM_ID",
    "VERCEL_PROJECT_ID",
  ]);
  // Env vars first, Neon branch second — a failed env cleanup leaves
  // the branch (and therefore the retry path via reconcile) intact,
  // while the reverse order orphans the vars beyond discovery.
  if (!env.PREVIEW_GIT_BRANCH) {
    console.warn(
      `${TAG} PREVIEW_GIT_BRANCH unset — skipping Vercel env cleanup`,
    );
  } else {
    // The env vars are scoped per git branch: if another PR is still
    // open on the same head ref it still needs them (they'll be
    // rewritten to that PR's own preview branch on its next provision).
    const closedPr = Number(
      PREVIEW_BRANCH_RE.exec(env.PREVIEW_BRANCH_NAME!)?.[1] ?? NaN,
    );
    const survivors = await openPrsWithRef(
      env,
      fetcher,
      env.PREVIEW_GIT_BRANCH,
      Number.isFinite(closedPr) ? closedPr : undefined,
    );
    if (survivors && survivors.length > 0) {
      console.log(
        `${TAG} keeping branch-scoped env vars — open PR(s) ` +
          `${survivors.map((n) => `#${n}`).join(", ")} share ` +
          `${env.PREVIEW_GIT_BRANCH}`,
      );
    } else {
      if (survivors === null) {
        console.warn(
          `${TAG} could not verify whether another open PR uses ` +
            `${env.PREVIEW_GIT_BRANCH} — deleting env vars anyway (the ` +
            `vars point at the deleted branch; keeping them would be worse)`,
        );
      }
      await deleteBranchEnvs(env, fetcher, env.PREVIEW_GIT_BRANCH);
    }
  }
  const deleted = await deletePreviewBranch(
    env,
    fetcher,
    env.PREVIEW_BRANCH_NAME!,
  );
  if (!deleted) {
    console.log(`${TAG} teardown complete (branch was already absent)`);
  }
}

type PullState = {
  state: string;
  head: { ref: string };
  closed_at?: string | null;
};

/**
 * Deletion eligibility for one `preview/pr-<n>` branch, given the state
 * of its owning PR. Deletion requires positive ownership verification —
 * a closed PR — plus expiry of the close grace period. Anything
 * unverifiable is retained, never deleted.
 */
export function classifyPreviewBranch(
  prNumber: string,
  pr: PullState | null,
  now: number = Date.now(),
): { eligible: boolean; reason: string } {
  if (!pr) {
    return {
      eligible: false,
      reason: `PR #${prNumber} lookup failed — unknown ownership, retaining`,
    };
  }
  if (pr.state === "open") {
    return {
      eligible: false,
      reason: `PR #${prNumber} still open, keeping`,
    };
  }
  if (pr.state !== "closed") {
    return {
      eligible: false,
      reason: `PR #${prNumber} state ${JSON.stringify(pr.state)} is neither open nor closed — unknown ownership, retaining`,
    };
  }
  // Deletion requires a verifiable close timestamp: a missing or
  // unparseable closed_at cannot prove the grace period elapsed.
  const closedAt = pr.closed_at ? Date.parse(pr.closed_at) : NaN;
  if (!Number.isFinite(closedAt)) {
    return {
      eligible: false,
      reason: `PR #${prNumber} is closed but closed_at is missing or unparseable — cannot verify the grace period, retaining`,
    };
  }
  const closedAgo = now - closedAt;
  if (closedAgo < RECONCILE_CLOSE_GRACE_MS) {
    return {
      eligible: false,
      reason: `PR #${prNumber} closed ${Math.round(closedAgo / 60000)}m ago — inside the ${Math.round(RECONCILE_CLOSE_GRACE_MS / 60000)}m grace period, retaining (absorbs close→reopen races)`,
    };
  }
  return { eligible: true, reason: `PR #${prNumber} is closed` };
}

export async function reconcile(env: Env, fetcher: Fetcher): Promise<void> {
  requireEnv(env, [
    "NEON_API_KEY",
    "NEON_PROJECT_ID",
    "VERCEL_TOKEN",
    "VERCEL_TEAM_ID",
    "VERCEL_PROJECT_ID",
    "GITHUB_TOKEN",
    "GITHUB_REPOSITORY",
  ]);
  // Deletion is opt-OUT, never default: only an explicit DRY_RUN=false
  // (manual workflow_dispatch) deletes. Scheduled runs always dry-run.
  const dryRun = env.DRY_RUN !== "false";
  if (dryRun) {
    console.log(`${TAG} [dry-run] reporting only — nothing will be deleted`);
  }
  const data = await neonJson<{ branches: NeonBranch[] }>(
    env,
    fetcher,
    `/projects/${env.NEON_PROJECT_ID}/branches`,
  );
  const previews = data.branches.filter((b) => PREVIEW_BRANCH_RE.test(b.name));
  console.log(`${TAG} found ${previews.length} preview branch(es)`);
  let deleted = 0;
  let retained = 0;
  for (const branch of previews) {
    const prNumber = PREVIEW_BRANCH_RE.exec(branch.name)![1]!;
    const pr = await github<PullState>(
      env,
      fetcher,
      `/repos/${env.GITHUB_REPOSITORY}/pulls/${prNumber}`,
    );
    const verdict = classifyPreviewBranch(prNumber, pr);
    console.log(`${TAG} ${branch.name} — ${verdict.reason}`);
    // Weekly renewal heartbeat: an open PR's branch gets a fresh TTL
    // here even if it never sees another provision event. Without this,
    // a quiet long-lived PR's database would silently expire. A failed
    // renewal is non-fatal (warn inside setBranchExpiration): the
    // current TTL still holds and the next sweep retries; worst case
    // the branch expires and is recreated on the PR's next event.
    if (pr?.state === "open") {
      await setBranchExpiration(env, fetcher, branch);
    }
    if (!verdict.eligible) {
      retained++;
      continue;
    }
    const opts = { dryRun };
    try {
      // Env vars first: reconcile discovers work by listing Neon
      // branches, so deleting the branch before its vars would orphan
      // them beyond any later retry. A leftover branch after a failed
      // env cleanup is still visible to the next sweep.
      const survivors = await openPrsWithRef(
        env,
        fetcher,
        pr!.head.ref,
        Number(prNumber),
      );
      if (survivors && survivors.length > 0) {
        console.log(
          `${TAG} keeping env vars for ${pr!.head.ref} — open PR(s) ` +
            `${survivors.map((n) => `#${n}`).join(", ")} share the branch`,
        );
      } else {
        await deleteBranchEnvs(env, fetcher, pr!.head.ref, opts);
      }
      await deletePreviewBranch(env, fetcher, branch.name, opts);
      deleted++;
    } catch (error) {
      // One malformed or protected branch must not stop the sweep —
      // report it as retained and keep going.
      console.warn(
        `${TAG} ${branch.name} skipped: ${error instanceof Error ? error.message : String(error)}`,
      );
      retained++;
    }
  }
  console.log(
    `${TAG} reconcile complete: ${deleted} ${dryRun ? "candidate(s) reported" : "deleted"}, ${retained} retained`,
  );
}

// --- Entrypoint ------------------------------------------------------------

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === "gate") {
    // Pure event-context check — no API access needed.
    await gate(process.env);
    return;
  }
  const commands = { provision, teardown, reconcile };
  const fn = commands[command as keyof typeof commands];
  if (!fn) {
    fail(
      `usage: tsx scripts/neon-preview.ts <gate|provision|teardown|reconcile>`,
    );
  }
  await fn(process.env, fetch);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch(() => {
    process.exitCode = process.exitCode ?? 1;
    process.exit(process.exitCode);
  });
}
