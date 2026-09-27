import { describe, expect, it, vi } from "vitest";

import { runVercelBuild, type Runner } from "./vercel-build";

const ok: Runner = () => ({ status: 0 });
const failMigrate: Runner = (cmd, args) =>
  args.includes("db:migrate:deploy") ? { status: 1 } : { status: 0 };

const PROD_DB = "postgresql://u:p@prod.example.neon.tech/db";
const PREVIEW_DB = "postgresql://u:p@preview-branch.example.neon.tech/db";

describe("runVercelBuild", () => {
  it("production: fails closed when DATABASE_URL is absent", () => {
    const run = vi.fn(ok);
    const code = runVercelBuild({ VERCEL_ENV: "production" }, run);
    expect(code).toBe(1);
    expect(run).not.toHaveBeenCalled();
  });

  it("production: migrates then builds", () => {
    const order: string[] = [];
    const run: Runner = (_cmd, args) => {
      order.push(args.join(" "));
      return { status: 0 };
    };
    expect(
      runVercelBuild({ VERCEL_ENV: "production", DATABASE_URL: PROD_DB }, run),
    ).toBe(0);
    expect(order).toEqual(["run db:migrate:deploy", "run build"]);
  });

  it("production: a failed migration aborts the build", () => {
    const run = vi.fn(failMigrate);
    const code = runVercelBuild(
      { VERCEL_ENV: "production", DATABASE_URL: PROD_DB },
      run,
    );
    expect(code).toBe(1);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("preview without DATABASE_URL: skips migrations, still builds", () => {
    const run = vi.fn(ok);
    expect(runVercelBuild({ VERCEL_ENV: "preview" }, run)).toBe(0);
    expect(run).toHaveBeenCalledTimes(1); // build only
  });

  it("preview without APP_PRODUCTION_DB_HOST: skips migrations, still builds", () => {
    const run = vi.fn(ok);
    expect(
      runVercelBuild({ VERCEL_ENV: "preview", DATABASE_URL: PREVIEW_DB }, run),
    ).toBe(0);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("preview pointing at the production host: refuses to build", () => {
    const run = vi.fn(ok);
    const code = runVercelBuild(
      {
        VERCEL_ENV: "preview",
        DATABASE_URL: PROD_DB,
        APP_PRODUCTION_DB_HOST: "prod.example.neon.tech",
      },
      run,
    );
    expect(code).toBe(1);
    expect(run).not.toHaveBeenCalled();
  });

  it("preview on a non-production host: migrates then builds", () => {
    const order: string[] = [];
    const run: Runner = (_cmd, args) => {
      order.push(args.join(" "));
      return { status: 0 };
    };
    expect(
      runVercelBuild(
        {
          VERCEL_ENV: "preview",
          DATABASE_URL: PREVIEW_DB,
          APP_PRODUCTION_DB_HOST: "prod.example.neon.tech",
        },
        run,
      ),
    ).toBe(0);
    expect(order).toEqual(["run db:migrate:deploy", "run build"]);
  });

  it("local/CI (no VERCEL_ENV): skips migrations, builds only", () => {
    const run = vi.fn(ok);
    expect(runVercelBuild({ DATABASE_URL: PREVIEW_DB }, run)).toBe(0);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
