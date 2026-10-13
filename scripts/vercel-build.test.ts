import { describe, expect, it, vi } from "vitest";

import { runVercelBuild, type Runner } from "./vercel-build";

const ok: Runner = () => ({ status: 0 });
const failMigrate: Runner = (cmd, args) =>
  args.includes("db:migrate:deploy") ? { status: 1 } : { status: 0 };

const PROD_HOST = "ep-prod.us-east-2.aws.neon.tech";
const PROD_DB = `postgresql://u:p@${PROD_HOST}/db`;
const PROD_DB_POOLED = `postgresql://u:p@ep-prod-pooler.us-east-2.aws.neon.tech/db`;

const PREVIEW_HOST = "ep-preview-123.us-east-2.aws.neon.tech";
const PREVIEW_DB = `postgresql://u:p@${PREVIEW_HOST}/db`;
const PREVIEW_DB_POOLED = `postgresql://u:p@ep-preview-123-pooler.us-east-2.aws.neon.tech/db`;

const previewEnv = {
  VERCEL_ENV: "preview",
  DATABASE_URL: PREVIEW_DB_POOLED,
  DATABASE_URL_UNPOOLED: PREVIEW_DB,
  APP_PRODUCTION_DB_HOST: PROD_HOST,
  APP_PREVIEW_DB_HOST: PREVIEW_HOST,
};

describe("runVercelBuild — production", () => {
  it("fails closed when DATABASE_URL is absent", () => {
    const run = vi.fn(ok);
    const code = runVercelBuild({ VERCEL_ENV: "production" }, run);
    expect(code).toBe(1);
    expect(run).not.toHaveBeenCalled();
  });

  it("fails closed when DATABASE_URL_UNPOOLED is absent", () => {
    const run = vi.fn(ok);
    const code = runVercelBuild(
      { VERCEL_ENV: "production", DATABASE_URL: PROD_DB },
      run,
    );
    expect(code).toBe(1);
    expect(run).not.toHaveBeenCalled();
  });

  it("fails closed when APP_PRODUCTION_DB_HOST is absent", () => {
    const run = vi.fn(ok);
    const code = runVercelBuild(
      {
        VERCEL_ENV: "production",
        DATABASE_URL: PROD_DB_POOLED,
        DATABASE_URL_UNPOOLED: PROD_DB,
      },
      run,
    );
    expect(code).toBe(1);
    expect(run).not.toHaveBeenCalled();
  });

  it("refuses when a URL does not resolve to the production host", () => {
    const run = vi.fn(ok);
    const code = runVercelBuild(
      {
        VERCEL_ENV: "production",
        DATABASE_URL: PROD_DB_POOLED,
        DATABASE_URL_UNPOOLED: PREVIEW_DB,
        APP_PRODUCTION_DB_HOST: PROD_HOST,
      },
      run,
    );
    expect(code).toBe(1);
    expect(run).not.toHaveBeenCalled();
  });

  it("migrates then builds on the verified production host (pooled + direct)", () => {
    const order: string[] = [];
    const run: Runner = (_cmd, args) => {
      order.push(args.join(" "));
      return { status: 0 };
    };
    expect(
      runVercelBuild(
        {
          VERCEL_ENV: "production",
          DATABASE_URL: PROD_DB_POOLED,
          DATABASE_URL_UNPOOLED: PROD_DB,
          APP_PRODUCTION_DB_HOST: PROD_HOST,
        },
        run,
      ),
    ).toBe(0);
    expect(order).toEqual(["run db:migrate:deploy", "run build"]);
  });

  it("a failed migration aborts the build", () => {
    const run = vi.fn(failMigrate);
    const code = runVercelBuild(
      {
        VERCEL_ENV: "production",
        DATABASE_URL: PROD_DB_POOLED,
        DATABASE_URL_UNPOOLED: PROD_DB,
        APP_PRODUCTION_DB_HOST: PROD_HOST,
      },
      run,
    );
    expect(code).toBe(1);
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe("runVercelBuild — preview", () => {
  it("without DATABASE_URL: skips migrations, still builds", () => {
    const run = vi.fn(ok);
    expect(runVercelBuild({ VERCEL_ENV: "preview" }, run)).toBe(0);
    expect(run).toHaveBeenCalledTimes(1); // build only
  });

  it("with DATABASE_URL but no UNPOOLED: fails closed", () => {
    const run = vi.fn(ok);
    expect(
      runVercelBuild(
        { VERCEL_ENV: "preview", DATABASE_URL: PREVIEW_DB_POOLED },
        run,
      ),
    ).toBe(1);
    expect(run).not.toHaveBeenCalled();
  });

  it("without APP_PRODUCTION_DB_HOST: fails closed (cannot exclude production)", () => {
    const run = vi.fn(ok);
    const env = { ...previewEnv, APP_PRODUCTION_DB_HOST: undefined };
    expect(runVercelBuild(env, run)).toBe(1);
    expect(run).not.toHaveBeenCalled();
  });

  it("pointing at the production host: refuses to build", () => {
    const run = vi.fn(ok);
    const code = runVercelBuild(
      {
        ...previewEnv,
        DATABASE_URL: PROD_DB_POOLED,
        DATABASE_URL_UNPOOLED: PROD_DB,
      },
      run,
    );
    expect(code).toBe(1);
    expect(run).not.toHaveBeenCalled();
  });

  it("without APP_PREVIEW_DB_HOST: fails closed (unverifiable identity)", () => {
    const run = vi.fn(ok);
    const env = { ...previewEnv, APP_PREVIEW_DB_HOST: undefined };
    expect(runVercelBuild(env, run)).toBe(1);
    expect(run).not.toHaveBeenCalled();
  });

  it("APP_PREVIEW_DB_HOST equal to the production host: refuses", () => {
    const run = vi.fn(ok);
    expect(
      runVercelBuild({ ...previewEnv, APP_PREVIEW_DB_HOST: PROD_HOST }, run),
    ).toBe(1);
    expect(run).not.toHaveBeenCalled();
  });

  it("URL on a host other than the verified preview host: refuses", () => {
    const run = vi.fn(ok);
    expect(
      runVercelBuild(
        {
          ...previewEnv,
          DATABASE_URL_UNPOOLED:
            "postgresql://u:p@ep-other-999.us-east-2.aws.neon.tech/db",
        },
        run,
      ),
    ).toBe(1);
    expect(run).not.toHaveBeenCalled();
  });

  it("verified pooled + direct endpoints of the preview host: migrates then builds", () => {
    const order: string[] = [];
    const run: Runner = (_cmd, args) => {
      order.push(args.join(" "));
      return { status: 0 };
    };
    expect(runVercelBuild(previewEnv, run)).toBe(0);
    expect(order).toEqual(["run db:migrate:deploy", "run build"]);
  });

  it("a failed migration aborts the build", () => {
    const run = vi.fn(failMigrate);
    expect(runVercelBuild(previewEnv, run)).toBe(1);
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe("runVercelBuild — local/CI", () => {
  it("no VERCEL_ENV: skips migrations, builds only", () => {
    const run = vi.fn(ok);
    expect(runVercelBuild({ DATABASE_URL: PREVIEW_DB }, run)).toBe(0);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
