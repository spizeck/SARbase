import { describe, expect, it, vi } from "vitest";

// The verification script is the owner's read-only proof of the live
// pipeline — mock the CLI boundary and assert the verdict logic for
// each wiring state the runbook cares about.

const { spawnSyncMock } = vi.hoisted(() => ({ spawnSyncMock: vi.fn() }));
vi.mock("node:child_process", () => ({ spawnSync: spawnSyncMock }));

import { verifyGuardDutyDelivery } from "./guardduty-verify";

const BUCKET = "sarbase-documents-prod-983902695382";
const ENDPOINT = "https://example.com/api/internal/guardduty-scan-result";

type AwsFn = (args: string[]) => {
  ok: boolean;
  json: unknown;
  stderr: string;
};

function ok(json: unknown) {
  return { ok: true as const, json, stderr: "" };
}
function fail(stderr: string) {
  return { ok: false as const, json: null, stderr };
}

/** Fully-wired AWS responses keyed by the CLI verb (args[0..1]). */
function healthyAws(): AwsFn {
  return (args: string[]) => {
    const key = args.slice(0, 2).join(" ");
    switch (key) {
      case "sts get-caller-identity":
        return ok({ Account: "983902695382" });
      case "s3api get-bucket-versioning":
        return ok({ Status: "Enabled" });
      case "guardduty list-malware-protection-plans":
        return ok({ MalwareProtectionPlans: [{ MalwareProtectionPlanId: "p1" }] });
      case "guardduty get-malware-protection-plan":
        return ok({
          ProtectedResource: { S3Bucket: { BucketName: BUCKET } },
          Actions: { Tagging: { Status: "ENABLED" } },
          Status: "ACTIVE",
        });
      case "events describe-rule":
        return ok({
          State: "ENABLED",
          EventBusName: "default",
          EventPattern: JSON.stringify({
            source: ["aws.guardduty"],
            detail: {
              s3ObjectDetails: {
                bucketName: [BUCKET],
                objectKey: [{ prefix: "organizations/" }],
              },
            },
          }),
        });
      case "events list-targets-by-rule":
        return ok({
          Targets: [
            {
              Arn: "arn:aws:events:us-east-1:123:api-destination/x",
              RoleArn: "arn:aws:iam::123:role/invoke",
              DeadLetterConfig: { Arn: "arn:aws:sqs:us-east-1:123:dlq" },
            },
          ],
        });
      case "events describe-api-destination":
        return ok({
          ConnectionState: "AUTHORIZED",
          InvocationEndpoint: ENDPOINT,
        });
      case "events describe-connection":
        return ok({ ConnectionState: "AUTHORIZED", AuthType: "API_KEY" });
      case "sqs get-queue-url":
        return ok({ QueueUrl: "https://sqs/queue" });
      case "sqs get-queue-attributes":
        return ok({ Attributes: { ApproximateNumberOfMessages: "0" } });
      case "cloudwatch describe-alarms":
        return ok({ MetricAlarms: [{ AlarmName: "dlq", StateValue: "OK" }] });
      default:
        return fail(`unstubbed call: ${key}`);
    }
  };
}

function stubCliVersion() {
  spawnSyncMock.mockReturnValue({ status: 0, stdout: "aws-cli/2.x", error: null });
}

function healthyFetch(): typeof fetch {
  return (async () => new Response("{}", { status: 401 })) as typeof fetch;
}

const base = {
  region: "us-east-1",
  bucket: BUCKET,
  endpoint: ENDPOINT,
};

async function run(overrides: Partial<Parameters<typeof verifyGuardDutyDelivery>[0]> = {}) {
  stubCliVersion();
  return verifyGuardDutyDelivery({
    ...base,
    aws: healthyAws(),
    fetch: healthyFetch(),
    ...overrides,
  });
}

function byName(results: Awaited<ReturnType<typeof verifyGuardDutyDelivery>>, name: string) {
  const r = results.find((x) => x.name === name);
  expect(r, `missing check: ${name}`).toBeTruthy();
  return r!;
}

describe("verifyGuardDutyDelivery", () => {
  it("passes every check on a correctly wired stack", async () => {
    const results = await run();
    expect(results.every((r) => r.status === "PASS")).toBe(true);
    expect(results.length).toBe(10);
  });

  it("fails closed when the aws CLI is unusable", async () => {
    spawnSyncMock.mockReturnValue({ error: new Error("not found") });
    const results = await verifyGuardDutyDelivery({
      ...base,
      aws: () => fail("no credentials"),
      fetch: healthyFetch(),
    });
    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe("FAIL");
  });

  it("fails when the bucket is not versioned", async () => {
    const results = await run({
      aws: (args) =>
        args[1] === "get-bucket-versioning" ? ok({}) : healthyAws()(args),
    });
    expect(byName(results, "bucket versioning enabled").status).toBe("FAIL");
  });

  it("fails when no protection plan covers the bucket", async () => {
    const results = await run({
      aws: (args) =>
        args[1] === "get-malware-protection-plan"
          ? ok({ ProtectedResource: { S3Bucket: { BucketName: "other" } } })
          : healthyAws()(args),
    });
    expect(byName(results, "GuardDuty protection plan").status).toBe("FAIL");
  });

  it("fails when the rule is disabled or scoped to a different bucket", async () => {
    const results = await run({
      aws: (args) =>
        args[1] === "describe-rule"
          ? ok({
              State: "ENABLED",
              EventPattern: JSON.stringify({
                detail: { s3ObjectDetails: { bucketName: ["other-bucket"] } },
              }),
            })
          : healthyAws()(args),
    });
    expect(
      byName(results, "EventBridge rule enabled and scoped").status,
    ).toBe("FAIL");
  });

  it("fails when the API destination points at a different endpoint", async () => {
    const results = await run({
      aws: (args) =>
        args[1] === "describe-api-destination"
          ? ok({
              ConnectionState: "AUTHORIZED",
              InvocationEndpoint: "https://evil.example.com/hook",
            })
          : healthyAws()(args),
    });
    expect(
      byName(results, "API destination authorized and pointed at the app")
        .status,
    ).toBe("FAIL");
  });

  it("fails when the DLQ holds undelivered messages", async () => {
    const results = await run({
      aws: (args) =>
        args[1] === "get-queue-attributes"
          ? ok({ Attributes: { ApproximateNumberOfMessages: "3" } })
          : healthyAws()(args),
    });
    expect(
      byName(results, "dead-letter queue exists and is empty").status,
    ).toBe("FAIL");
  });

  it("fails when the ingest endpoint 404s (route not deployed)", async () => {
    const results = await run({
      fetch: (async () => new Response("nope", { status: 404 })) as typeof fetch,
    });
    expect(
      byName(results, "ingest endpoint reachable and fails closed").status,
    ).toBe("FAIL");
  });

  it("reports MANUAL when GuardDuty is not API-visible", async () => {
    const results = await run({
      aws: (args) =>
        args[1] === "list-malware-protection-plans"
          ? fail("AccessDenied")
          : healthyAws()(args),
    });
    expect(byName(results, "GuardDuty protection plan").status).toBe(
      "MANUAL",
    );
  });
});
