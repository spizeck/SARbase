import { afterEach, describe, expect, it, vi } from "vitest";

import {
  classifyPreviewBranch,
  deletePreviewBranch,
  provision,
  provisioningDecision,
  reconcile,
  teardown,
  type Fetcher,
} from "./neon-preview";

/**
 * Mocked Neon/Vercel/GitHub API router. No real provider calls are ever
 * made — lifecycle tests run entirely against recorded fixtures.
 */

type Call = { method: string; url: string; body?: unknown };

type Fixture = {
  branches?: {
    id: string;
    name: string;
    parent_id?: string;
    primary?: boolean;
    protected?: boolean;
  }[];
  /** Neon GET /branches/<id> responses keyed by branch id. */
  branchesById?: Record<string, unknown>;
  /** Vercel env vars (key/target/gitBranch/id). */
  vercelEnvs?: {
    id?: string;
    key: string;
    target?: string[];
    gitBranch?: string | null;
  }[];
  /** GitHub pull responses keyed by PR number; absent key -> 404. */
  pulls?: Record<
    string,
    { state: string; head: { ref: string }; closed_at?: string | null } | null
  >;
  /** GitHub GET /pulls?state=open&head=... list responses. */
  openPulls?: { number: number; head: { ref: string } }[];
};

function makeFetch(fixture: Fixture): { fetcher: Fetcher; calls: Call[] } {
  const calls: Call[] = [];
  const json = (data: unknown, status = 200) =>
    ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => data,
    }) as Response;

  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    let body: unknown;
    if (typeof init?.body === "string") {
      body = JSON.parse(init.body);
    }
    calls.push({ method, url: url.toString(), body });

    if (url.hostname === "console.neon.tech") {
      const branchesMatch = /^\/api\/v2\/projects\/[^/]+\/branches$/.exec(
        url.pathname,
      );
      const branchMatch =
        /^\/api\/v2\/projects\/[^/]+\/branches\/([^/]+)$/.exec(url.pathname);
      if (branchesMatch && method === "GET") {
        return json({ branches: fixture.branches ?? [] });
      }
      if (branchMatch && method === "GET") {
        const branch = fixture.branchesById?.[branchMatch[1]!];
        return branch ? json(branch) : json({}, 404);
      }
      if (branchMatch && method === "DELETE") {
        return json({}, 200);
      }
      return json({}, 500);
    }

    if (url.hostname === "api.vercel.com") {
      if (url.pathname === "/v13/deployments" && method === "POST") {
        return json({ url: "https://preview.example.vercel.app" });
      }
      const envListMatch = /^\/v9\/projects\/[^/]+\/env$/.exec(url.pathname);
      const envItemMatch = /^\/v9\/projects\/[^/]+\/env\/([^/]+)$/.exec(
        url.pathname,
      );
      const envUpsertMatch = /^\/v10\/projects\/[^/]+\/env$/.exec(url.pathname);
      if (envUpsertMatch && method === "POST") {
        return json({});
      }
      if (envListMatch && method === "GET") {
        const gitBranch = url.searchParams.get("gitBranch");
        const envs = (fixture.vercelEnvs ?? []).filter(
          (e) => !gitBranch || e.gitBranch === gitBranch,
        );
        return json({ envs });
      }
      if (envItemMatch && method === "DELETE") {
        return json({});
      }
      return json({}, 500);
    }

    if (url.hostname === "api.github.com") {
      const pullMatch = /^\/repos\/[^/]+\/[^/]+\/pulls\/(\d+)$/.exec(
        url.pathname,
      );
      if (pullMatch) {
        const pr = fixture.pulls?.[pullMatch[1]!];
        return pr === undefined || pr === null ? json({}, 404) : json(pr);
      }
      if (url.pathname.endsWith("/pulls")) {
        const head = url.searchParams.get("head")?.split(":")[1];
        const list = (fixture.openPulls ?? []).filter(
          (p) => !head || p.head.ref === head,
        );
        return json(list);
      }
      return json({}, 404);
    }

    return json({}, 500);
  }) as Fetcher;

  return { fetcher, calls };
}

const ENV = {
  NEON_API_KEY: "neon-key",
  NEON_PROJECT_ID: "p1",
  NEON_PARENT_BRANCH: "testing",
  VERCEL_TOKEN: "vercel-token",
  VERCEL_TEAM_ID: "team1",
  VERCEL_PROJECT_ID: "vp1",
  VERCEL_PROJECT_NAME: "sarbase",
  GITHUB_REPOSITORY: "spizeck/SARbase",
  GITHUB_TOKEN: "gh-token",
};

const PREVIEW_BRANCH = {
  id: "br-preview-1",
  name: "preview/pr-42",
  parent_id: "br-testing",
};

const BASE_FIXTURE: Fixture = {
  branches: [
    { id: "br-main", name: "main" },
    { id: "br-testing", name: "testing" },
    PREVIEW_BRANCH,
  ],
  branchesById: { "br-preview-1": { branch: PREVIEW_BRANCH } },
};

// `fail()` in the script sets process.exitCode = 1 — reset it between
// tests so a deliberately-refused path does not leak a failing exit
// code into the vitest process.
afterEach(() => {
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

describe("provisioningDecision", () => {
  const base = {
    authorLogin: "chad",
    headRepo: "spizeck/SARbase",
    repo: "spizeck/SARbase",
    state: "open",
  };

  it("allows an eligible same-repo open PR", () => {
    expect(provisioningDecision(base).allow).toBe(true);
  });

  it("denies Dependabot regardless of other fields", () => {
    expect(
      provisioningDecision({ ...base, authorLogin: "dependabot[bot]" }).allow,
    ).toBe(false);
    expect(
      provisioningDecision({ ...base, authorLogin: "Dependabot[bot]" }).allow,
    ).toBe(false);
  });

  it("denies fork PRs", () => {
    expect(
      provisioningDecision({ ...base, headRepo: "someone/SARbase" }).allow,
    ).toBe(false);
    expect(provisioningDecision({ ...base, headRepo: undefined }).allow).toBe(
      false,
    );
  });

  it("denies PRs that are not open", () => {
    expect(provisioningDecision({ ...base, state: "closed" }).allow).toBe(
      false,
    );
  });
});

describe("classifyPreviewBranch", () => {
  const now = Date.now();

  it("retains a branch when the owning PR cannot be verified", () => {
    expect(classifyPreviewBranch("42", null, now).eligible).toBe(false);
  });

  it("retains a branch whose PR is still open", () => {
    const pr = { state: "open", head: { ref: "feat/x" } };
    expect(classifyPreviewBranch("42", pr, now).eligible).toBe(false);
  });

  it("retains a branch whose PR has an unexpected state", () => {
    const pr = { state: "merged-ish", head: { ref: "feat/x" } };
    expect(classifyPreviewBranch("42", pr, now).eligible).toBe(false);
  });

  it("retains a closed PR with missing/unparseable closed_at", () => {
    const pr = {
      state: "closed",
      head: { ref: "feat/x" },
      closed_at: null,
    };
    expect(classifyPreviewBranch("42", pr, now).eligible).toBe(false);
    expect(
      classifyPreviewBranch("42", { ...pr, closed_at: "not-a-date" }, now)
        .eligible,
    ).toBe(false);
  });

  it("retains a recently-closed PR inside the grace period", () => {
    const pr = {
      state: "closed",
      head: { ref: "feat/x" },
      closed_at: new Date(now - 10 * 60 * 1000).toISOString(),
    };
    expect(classifyPreviewBranch("42", pr, now).eligible).toBe(false);
  });

  it("marks a closed PR past the grace period eligible", () => {
    const pr = {
      state: "closed",
      head: { ref: "feat/x" },
      closed_at: new Date(now - 2 * 60 * 60 * 1000).toISOString(),
    };
    expect(classifyPreviewBranch("42", pr, now).eligible).toBe(true);
  });
});

describe("deletePreviewBranch", () => {
  it("refuses anything that is not preview/pr-<digits>", async () => {
    const { fetcher } = makeFetch(BASE_FIXTURE);
    await expect(deletePreviewBranch(ENV, fetcher, "main")).rejects.toThrow(
      /preview\/pr/,
    );
    await expect(deletePreviewBranch(ENV, fetcher, "testing")).rejects.toThrow(
      /preview\/pr/,
    );
    await expect(
      deletePreviewBranch(ENV, fetcher, "preview/pr-42; rm -rf"),
    ).rejects.toThrow(/preview\/pr/);
  });

  it("is idempotent when the branch is already absent", async () => {
    const { fetcher, calls } = makeFetch({
      branches: BASE_FIXTURE.branches!.slice(0, 2),
    });
    await expect(
      deletePreviewBranch(ENV, fetcher, "preview/pr-42"),
    ).resolves.toBe(false);
    expect(calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("refuses a protected or primary branch", async () => {
    const { fetcher } = makeFetch({
      branches: [
        { id: "br-testing", name: "testing" },
        { ...PREVIEW_BRANCH, protected: true },
      ],
    });
    await expect(
      deletePreviewBranch(ENV, fetcher, "preview/pr-42"),
    ).rejects.toThrow(/protected/);
  });

  it("refuses a preview branch whose parent is not testing", async () => {
    const { fetcher } = makeFetch({
      branches: [
        { id: "br-main", name: "main" },
        { id: "br-testing", name: "testing" },
        { ...PREVIEW_BRANCH, parent_id: "br-main" },
      ],
    });
    await expect(
      deletePreviewBranch(ENV, fetcher, "preview/pr-42"),
    ).rejects.toThrow(/parent/);
  });

  it("deletes a well-formed preview branch in non-dry-run mode", async () => {
    const { fetcher, calls } = makeFetch(BASE_FIXTURE);
    await expect(
      deletePreviewBranch(ENV, fetcher, "preview/pr-42"),
    ).resolves.toBe(true);
    expect(
      calls.some(
        (c) => c.method === "DELETE" && c.url.includes("br-preview-1"),
      ),
    ).toBe(true);
  });
});

const PROVISION_ENV = {
  ...ENV,
  NEON_BRANCH_ID: "br-preview-1",
  NEON_DB_URL: "postgresql://u:p@ep-prev-1.us-east-2.aws.neon.tech/neondb",
  NEON_DB_URL_POOLED:
    "postgresql://u:p@ep-prev-1-pooler.us-east-2.aws.neon.tech/neondb",
  NEON_DB_HOST: "ep-prev-1.us-east-2.aws.neon.tech",
  NEON_DB_HOST_POOLED: "ep-prev-1-pooler.us-east-2.aws.neon.tech",
  PREVIEW_BRANCH_NAME: "preview/pr-42",
  PREVIEW_GIT_BRANCH: "feat/thing",
  PR_AUTHOR_LOGIN: "chad",
  PR_HEAD_REPO: "spizeck/SARbase",
  PR_STATE: "open",
};

describe("provision", () => {
  it("refuses a denied PR before touching provider APIs", async () => {
    const { fetcher, calls } = makeFetch(BASE_FIXTURE);
    await expect(
      provision(
        { ...PROVISION_ENV, PR_AUTHOR_LOGIN: "dependabot[bot]" },
        fetcher,
      ),
    ).rejects.toThrow(/policy/);
    expect(calls).toHaveLength(0);
  });

  it("refuses when the resolved branch is not a child of testing", async () => {
    const { fetcher } = makeFetch({
      ...BASE_FIXTURE,
      branchesById: {
        "br-preview-1": {
          branch: { ...PREVIEW_BRANCH, parent_id: "br-main" },
        },
      },
    });
    await expect(provision(PROVISION_ENV, fetcher)).rejects.toThrow(
      /child of testing/,
    );
  });

  it("refuses when the connection URLs do not match the branch endpoint", async () => {
    const { fetcher, calls } = makeFetch(BASE_FIXTURE);
    await expect(
      provision(
        {
          ...PROVISION_ENV,
          NEON_DB_URL_POOLED:
            "postgresql://u:p@ep-OTHER.us-east-2.aws.neon.tech/neondb",
        },
        fetcher,
      ),
    ).rejects.toThrow(/do not resolve/);
    // No Vercel writes may happen before the endpoint check passes.
    expect(calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("writes the three branch-scoped preview env vars and is repeatable", async () => {
    const { fetcher, calls } = makeFetch(BASE_FIXTURE);
    await provision(PROVISION_ENV, fetcher);
    await provision(PROVISION_ENV, fetcher); // idempotent re-run

    const upserts = calls.filter(
      (c) => c.method === "POST" && c.url.includes("/v10/"),
    );
    expect(upserts).toHaveLength(6); // 3 keys x 2 runs
    for (const [key, value] of [
      ["DATABASE_URL", PROVISION_ENV.NEON_DB_URL_POOLED],
      ["DATABASE_URL_UNPOOLED", PROVISION_ENV.NEON_DB_URL],
      ["APP_PREVIEW_DB_HOST", PROVISION_ENV.NEON_DB_HOST_POOLED],
    ]) {
      const hit = upserts.find((c) => (c.body as { key: string }).key === key);
      expect(hit).toBeDefined();
      expect(hit!.body).toMatchObject({
        value,
        type: "sensitive",
        target: ["preview"],
        gitBranch: "feat/thing",
      });
    }
  });

  it("refuses to overwrite another open PR's vars on a shared head ref", async () => {
    const { fetcher, calls } = makeFetch({
      ...BASE_FIXTURE,
      openPulls: [
        { number: 42, head: { ref: "feat/thing" } },
        { number: 50, head: { ref: "feat/thing" } },
      ],
    });
    await expect(provision(PROVISION_ENV, fetcher)).rejects.toThrow(/#50/);
    expect(calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("proceeds when only this PR uses the head ref", async () => {
    const { fetcher, calls } = makeFetch({
      ...BASE_FIXTURE,
      openPulls: [{ number: 42, head: { ref: "feat/thing" } }],
    });
    await provision(PROVISION_ENV, fetcher);
    expect(
      calls.some((c) => c.method === "POST" && c.url.includes("/v10/")),
    ).toBe(true);
  });

  it("triggers a redeployment only when TRIGGER_DEPLOY=true", async () => {
    const { fetcher, calls } = makeFetch(BASE_FIXTURE);
    await provision(
      { ...PROVISION_ENV, TRIGGER_DEPLOY: "true", PR_HEAD_SHA: "abc123" },
      fetcher,
    );
    expect(calls.some((c) => c.url.includes("/v13/deployments"))).toBe(true);

    const second = makeFetch(BASE_FIXTURE);
    await provision(PROVISION_ENV, second.fetcher);
    expect(second.calls.some((c) => c.url.includes("/v13/deployments"))).toBe(
      false,
    );
  });
});

describe("teardown", () => {
  it("deletes the preview branch and its branch-scoped env vars", async () => {
    const { fetcher, calls } = makeFetch({
      ...BASE_FIXTURE,
      vercelEnvs: [
        {
          id: "e1",
          key: "DATABASE_URL",
          target: ["preview"],
          gitBranch: "feat/thing",
        },
        {
          id: "e2",
          key: "APP_PREVIEW_DB_HOST",
          target: ["preview"],
          gitBranch: "feat/thing",
        },
        // Unrelated vars — must survive.
        {
          id: "e3",
          key: "OTHER",
          target: ["preview"],
          gitBranch: "feat/thing",
        },
        {
          id: "e4",
          key: "DATABASE_URL",
          target: ["preview"],
          gitBranch: "other-branch",
        },
      ],
    });
    await teardown(
      {
        ...ENV,
        PREVIEW_BRANCH_NAME: "preview/pr-42",
        PREVIEW_GIT_BRANCH: "feat/thing",
      },
      fetcher,
    );
    const deletes = calls.filter((c) => c.method === "DELETE");
    expect(deletes.some((c) => c.url.includes("br-preview-1"))).toBe(true);
    const envDeletes = deletes.filter((c) => c.url.includes("api.vercel.com"));
    expect(envDeletes.map((c) => c.url)).toHaveLength(2);
    expect(envDeletes.every((c) => /env\/(e1|e2)/.test(c.url))).toBe(true);
  });

  it("is idempotent when the branch is already absent", async () => {
    const { fetcher } = makeFetch({
      branches: BASE_FIXTURE.branches!.slice(0, 2),
    });
    await expect(
      teardown(
        {
          ...ENV,
          PREVIEW_BRANCH_NAME: "preview/pr-42",
          PREVIEW_GIT_BRANCH: "feat/thing",
        },
        fetcher,
      ),
    ).resolves.toBeUndefined();
  });

  it("keeps branch env vars when another open PR shares the head ref", async () => {
    const { fetcher, calls } = makeFetch({
      ...BASE_FIXTURE,
      vercelEnvs: [
        {
          id: "e1",
          key: "DATABASE_URL",
          target: ["preview"],
          gitBranch: "feat/thing",
        },
      ],
      openPulls: [{ number: 50, head: { ref: "feat/thing" } }],
    });
    await teardown(
      {
        ...ENV,
        PREVIEW_BRANCH_NAME: "preview/pr-42",
        PREVIEW_GIT_BRANCH: "feat/thing",
      },
      fetcher,
    );
    // Neon branch still deleted; Vercel env var survives.
    expect(calls.some((c) => c.url.includes("br-preview-1"))).toBe(true);
    expect(
      calls.filter(
        (c) => c.method === "DELETE" && c.url.includes("api.vercel.com"),
      ),
    ).toHaveLength(0);
  });
});

describe("reconcile", () => {
  const now = Date.now();
  const closedLongAgo = new Date(now - 2 * 60 * 60 * 1000).toISOString();

  const reconcileEnv = { ...ENV };

  it("defaults to dry-run — reports but never deletes", async () => {
    const { fetcher, calls } = makeFetch({
      branches: [{ id: "br-testing", name: "testing" }, PREVIEW_BRANCH],
      pulls: {
        "42": {
          state: "closed",
          head: { ref: "feat/thing" },
          closed_at: closedLongAgo,
        },
      },
    });
    await reconcile(reconcileEnv, fetcher);
    expect(calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("deletes only verified-closed, past-grace preview branches", async () => {
    const { fetcher, calls } = makeFetch({
      branches: [
        { id: "br-testing", name: "testing" },
        PREVIEW_BRANCH,
        { id: "br-p9", name: "preview/pr-9", parent_id: "br-testing" },
        { id: "br-p7", name: "preview/pr-7", parent_id: "br-testing" },
      ],
      pulls: {
        "42": {
          state: "closed",
          head: { ref: "feat/thing" },
          closed_at: closedLongAgo,
        },
        "9": { state: "open", head: { ref: "feat/open" } },
        // "7": lookup fails — must be retained.
      },
    });
    await reconcile({ ...reconcileEnv, DRY_RUN: "false" }, fetcher);
    const deleted = calls
      .filter((c) => c.method === "DELETE" && c.url.includes("neon.tech"))
      .map((c) => c.url);
    expect(deleted).toHaveLength(1);
    expect(deleted[0]).toContain("br-preview-1");
  });

  it("continues the sweep when one branch is refused, and keeps shared-ref env vars", async () => {
    const { fetcher, calls } = makeFetch({
      branches: [
        { id: "br-testing", name: "testing" },
        // pr-42's branch has a wrong parent — refused, must not abort.
        { ...PREVIEW_BRANCH, parent_id: "br-other" },
        { id: "br-p9", name: "preview/pr-9", parent_id: "br-testing" },
      ],
      pulls: {
        "42": {
          state: "closed",
          head: { ref: "feat/thing" },
          closed_at: closedLongAgo,
        },
        "9": {
          state: "closed",
          head: { ref: "feat/shared" },
          closed_at: closedLongAgo,
        },
      },
      // An open PR #50 still uses feat/shared — its env vars must stay.
      openPulls: [{ number: 50, head: { ref: "feat/shared" } }],
      vercelEnvs: [
        {
          id: "e9",
          key: "DATABASE_URL",
          target: ["preview"],
          gitBranch: "feat/shared",
        },
      ],
    });
    await reconcile({ ...reconcileEnv, DRY_RUN: "false" }, fetcher);
    // pr-9's Neon branch was still deleted despite pr-42's refusal.
    expect(
      calls.some((c) => c.method === "DELETE" && c.url.includes("br-p9")),
    ).toBe(true);
    // But its Vercel env vars survived — PR #50 shares the git branch.
    expect(
      calls.some((c) => c.method === "DELETE" && c.url.includes("/env/e9")),
    ).toBe(false);
  });
});
