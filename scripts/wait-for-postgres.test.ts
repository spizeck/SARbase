import { describe, expect, it } from "vitest";

import { buildProbeArgs, waitForPostgres } from "./wait-for-postgres";

const fast = { intervalMs: 0, timeoutMs: 5_000 };

describe("buildProbeArgs", () => {
  it("probes a real query over TCP inside the container", () => {
    const args = buildProbeArgs("postgres");
    expect(args.slice(0, 3)).toEqual(["compose", "exec", "-T"]);
    expect(args).toContain("postgres");
    const cmd = args.join(" ");
    // TCP host — the initdb-time server binds the unix socket only, so
    // this can only succeed against the final server.
    expect(cmd).toContain("-h 127.0.0.1");
    expect(cmd).toContain("select 1");
    // Credentials come from the container's own env — nothing hardcoded.
    expect(cmd).toContain('"$POSTGRES_PASSWORD"');
  });
});

describe("waitForPostgres", () => {
  it("returns after the required consecutive successes", async () => {
    let calls = 0;
    await waitForPostgres({
      ...fast,
      consecutive: 3,
      probe: () => {
        calls += 1;
        return { ok: true, stderr: "" };
      },
      log: () => {},
    });
    expect(calls).toBe(3);
  });

  it("survives a flap — the initdb shutdown resets the streak", async () => {
    // Simulates the real failure: temp server answers twice, dies, and
    // the final server answers thereafter. Readiness must not be
    // declared on the temp server's answers alone.
    const outcomes = [true, true, false, true, true, true];
    let calls = 0;
    await waitForPostgres({
      ...fast,
      consecutive: 3,
      probe: () => ({ ok: outcomes[calls++] ?? true, stderr: "down" }),
      log: () => {},
    });
    expect(calls).toBe(6);
  });

  it("fails diagnostically when postgres never becomes ready", async () => {
    await expect(
      waitForPostgres({
        consecutive: 2,
        intervalMs: 0,
        timeoutMs: 20,
        probe: () => ({ ok: false, stderr: "connection refused" }),
        // Injected — the real dumper shells out to `docker compose
        // logs`, whose first cold-start invocation can outlast the
        // test timeout on a fresh runner (observed CI flake).
        dumpLogs: () => "(stub logs)",
        log: () => {},
      }),
    ).rejects.toThrow(/did not become ready.*connection refused/s);
  });
});
