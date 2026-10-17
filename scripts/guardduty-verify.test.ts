import { describe, expect, it, vi } from "vitest";

// The verification script is the owner's read-only proof of the live
// pipeline — mock the CLI boundary and assert the verdict logic for
// each wiring state the runbook cares about. Mocks use the REAL AWS
// response field names (ApiDestinationState, HttpMethod, …); a mock
// that invents friendlier shapes would teach the script wrong.

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
        return ok({
          MalwareProtectionPlans: [{ MalwareProtectionPlanId: "p1" }],
        });
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
            "detail-type": ["GuardDuty Malware Protection Object Scan Result"],
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
              Arn: "arn:aws:events:us-east-1:123:api-destination/sarbase-prod-scan-ingest/x",
              RoleArn: "arn:aws:iam::123:role/sarbase-prod-scan-event-invoke",
              DeadLetterConfig: {
                Arn: "arn:aws:sqs:us-east-1:123:sarbase-prod-guardduty-scan-dlq",
              },
              RetryPolicy: {
                MaximumRetryAttempts: 10,
                MaximumEventAgeInSeconds: 3600,
              },
            },
          ],
        });
      case "events describe-api-destination":
        return ok({
          ApiDestinationState: "ACTIVE",
          InvocationEndpoint: ENDPOINT,
          HttpMethod: "POST",
          ConnectionArn:
            "arn:aws:events:us-east-1:123:connection/sarbase-prod-scan-webhook/abc",
        });
      case "events describe-connection":
        return ok({ ConnectionState: "AUTHORIZED", AuthType: "API_KEY" });
      case "sqs get-queue-url":
        return ok({ QueueUrl: "https://sqs/queue" });
      case "sqs get-queue-attributes":
        return ok({
          Attributes: {
            ApproximateNumberOfMessages: "0",
            ApproximateNumberOfMessagesNotVisible: "0",
            ApproximateNumberOfMessagesDelayed: "0",
          },
        });
      case "cloudwatch describe-alarms":
        return ok({
          MetricAlarms: [
            {
              AlarmName: "sarbase-prod-guardduty-scan-dlq",
              StateValue: "OK",
              Namespace: "AWS/SQS",
              MetricName: "ApproximateNumberOfMessagesVisible",
              Dimensions: [
                {
                  Name: "QueueName",
                  Value: "sarbase-prod-guardduty-scan-dlq",
                },
              ],
              Threshold: 0,
              ComparisonOperator: "GreaterThanThreshold",
              EvaluationPeriods: 1,
            },
          ],
        });
      default:
        return fail(`unstubbed call: ${key}`);
    }
  };
}

function healthyFetch(): typeof fetch {
  return (async () => new Response("{}", { status: 401 })) as typeof fetch;
}

const base = {
  region: "us-east-1",
  bucket: BUCKET,
  endpoint: ENDPOINT,
};

async function run(
  overrides: Partial<Parameters<typeof verifyGuardDutyDelivery>[0]> = {},
) {
  return verifyGuardDutyDelivery({
    ...base,
    aws: healthyAws(),
    awsVersion: () => true,
    fetch: healthyFetch(),
    ...overrides,
  });
}

function byName(
  results: Awaited<ReturnType<typeof verifyGuardDutyDelivery>>,
  name: string,
) {
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

  it("probes the endpoint with an unauthenticated POST, no redirects", async () => {
    let seen: { url: unknown; init: RequestInit | undefined } | null = null;
    const spy = (async (url: unknown, init?: RequestInit) => {
      seen = { url, init };
      return new Response("{}", { status: 401 });
    }) as typeof fetch;
    await run({ fetch: spy });
    expect(seen).not.toBeNull();
    expect(seen!.init?.method).toBe("POST");
    expect(seen!.init?.redirect).toBe("manual");
  });

  it("fails closed when the aws CLI binary is missing", async () => {
    // Identity would succeed — only the version probe fails.
    const results = await verifyGuardDutyDelivery({
      ...base,
      awsVersion: () => false,
      aws: healthyAws(),
      fetch: healthyFetch(),
    });
    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe("FAIL");
  });

  it("fails closed when credentials cannot be resolved", async () => {
    // CLI present — only the identity call fails.
    const results = await verifyGuardDutyDelivery({
      ...base,
      awsVersion: () => true,
      aws: (args) =>
        args[0] === "sts" ? fail("no credentials") : healthyAws()(args),
      fetch: healthyFetch(),
    });
    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe("FAIL");
  });

  it("rejects unsafe argument values before any CLI call", async () => {
    await expect(
      verifyGuardDutyDelivery({
        ...base,
        bucket: "bucket; rm -rf /",
        aws: healthyAws(),
        awsVersion: () => true,
        fetch: healthyFetch(),
      }),
    ).rejects.toThrow(/refusing to interpolate/);
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

  it("fails when the plan is inactive or tagging is off", async () => {
    const results = await run({
      aws: (args) =>
        args[1] === "get-malware-protection-plan"
          ? ok({
              ProtectedResource: { S3Bucket: { BucketName: BUCKET } },
              Actions: { Tagging: { Status: "DISABLED" } },
              Status: "ACTIVE",
            })
          : healthyAws()(args),
    });
    const check = byName(results, "GuardDuty protection plan");
    expect(check.status).toBe("FAIL");
    expect(check.detail).toContain("tagging=DISABLED");
  });

  it("fails when the rule filters the wrong bucket", async () => {
    // Everything else in the pattern is correct — only the bucket
    // condition is wrong, so this isolates the bucket check.
    const results = await run({
      aws: (args) =>
        args[1] === "describe-rule"
          ? ok({
              State: "ENABLED",
              EventBusName: "default",
              EventPattern: JSON.stringify({
                source: ["aws.guardduty"],
                "detail-type": [
                  "GuardDuty Malware Protection Object Scan Result",
                ],
                detail: {
                  s3ObjectDetails: {
                    bucketName: ["other-bucket"],
                    objectKey: [{ prefix: "organizations/" }],
                  },
                },
              }),
            })
          : healthyAws()(args),
    });
    expect(byName(results, "EventBridge rule enabled and scoped").status).toBe(
      "FAIL",
    );
  });

  it("fails when the pattern drops the organizations/ prefix filter", async () => {
    const results = await run({
      aws: (args) =>
        args[1] === "describe-rule"
          ? ok({
              State: "ENABLED",
              EventBusName: "default",
              EventPattern: JSON.stringify({
                source: ["aws.guardduty"],
                "detail-type": [
                  "GuardDuty Malware Protection Object Scan Result",
                ],
                detail: {
                  s3ObjectDetails: { bucketName: [BUCKET] },
                },
              }),
            })
          : healthyAws()(args),
    });
    expect(byName(results, "EventBridge rule enabled and scoped").status).toBe(
      "FAIL",
    );
  });

  it("fails when the rule target points at a different destination", async () => {
    const results = await run({
      aws: (args) =>
        args[1] === "list-targets-by-rule"
          ? ok({
              Targets: [
                {
                  Arn: "arn:aws:events:us-east-1:123:api-destination/other-dest/x",
                  RoleArn:
                    "arn:aws:iam::123:role/sarbase-prod-scan-event-invoke",
                  DeadLetterConfig: {
                    Arn: "arn:aws:sqs:us-east-1:123:sarbase-prod-guardduty-scan-dlq",
                  },
                  RetryPolicy: {
                    MaximumRetryAttempts: 10,
                    MaximumEventAgeInSeconds: 3600,
                  },
                },
              ],
            })
          : healthyAws()(args),
    });
    expect(byName(results, "rule targets wired to this pipeline").status).toBe(
      "FAIL",
    );
  });

  it("fails when the retry policy drifts", async () => {
    const results = await run({
      aws: (args) =>
        args[1] === "list-targets-by-rule"
          ? ok({
              Targets: [
                {
                  Arn: "arn:aws:events:us-east-1:123:api-destination/sarbase-prod-scan-ingest/x",
                  RoleArn:
                    "arn:aws:iam::123:role/sarbase-prod-scan-event-invoke",
                  DeadLetterConfig: {
                    Arn: "arn:aws:sqs:us-east-1:123:sarbase-prod-guardduty-scan-dlq",
                  },
                },
              ],
            })
          : healthyAws()(args),
    });
    expect(byName(results, "rule targets wired to this pipeline").status).toBe(
      "FAIL",
    );
  });

  it("fails when the API destination points at a different endpoint", async () => {
    const results = await run({
      aws: (args) =>
        args[1] === "describe-api-destination"
          ? ok({
              ApiDestinationState: "ACTIVE",
              InvocationEndpoint: "https://evil.example.com/hook",
              HttpMethod: "POST",
              ConnectionArn:
                "arn:aws:events:us-east-1:123:connection/sarbase-prod-scan-webhook/abc",
            })
          : healthyAws()(args),
    });
    expect(byName(results, "API destination wired to the app").status).toBe(
      "FAIL",
    );
  });

  it("fails when the destination uses a non-POST method or wrong connection", async () => {
    const results = await run({
      aws: (args) =>
        args[1] === "describe-api-destination"
          ? ok({
              ApiDestinationState: "ACTIVE",
              InvocationEndpoint: ENDPOINT,
              HttpMethod: "GET",
              ConnectionArn:
                "arn:aws:events:us-east-1:123:connection/other-conn/abc",
            })
          : healthyAws()(args),
    });
    const check = byName(results, "API destination wired to the app");
    expect(check.status).toBe("FAIL");
    expect(check.detail).toContain("HttpMethod=GET");
  });

  it("fails when the connection auth type is wrong", async () => {
    const results = await run({
      aws: (args) =>
        args[1] === "describe-connection"
          ? ok({
              ConnectionState: "AUTHORIZED",
              AuthType: "OAUTH_CLIENT_CREDENTIALS",
            })
          : healthyAws()(args),
    });
    expect(byName(results, "webhook connection authorized").status).toBe(
      "FAIL",
    );
  });

  it("fails when the DLQ holds visible OR in-flight messages", async () => {
    const results = await run({
      aws: (args) =>
        args[1] === "get-queue-attributes"
          ? ok({
              Attributes: {
                ApproximateNumberOfMessages: "0",
                ApproximateNumberOfMessagesNotVisible: "2",
                ApproximateNumberOfMessagesDelayed: "0",
              },
            })
          : healthyAws()(args),
    });
    expect(
      byName(results, "dead-letter queue exists and is empty").status,
    ).toBe("FAIL");
  });

  it("fails when the alarm watches the wrong metric or queue", async () => {
    const results = await run({
      aws: (args) =>
        args[1] === "describe-alarms"
          ? ok({
              MetricAlarms: [
                {
                  AlarmName: "sarbase-prod-guardduty-scan-dlq",
                  StateValue: "OK",
                  Namespace: "AWS/SQS",
                  MetricName: "ApproximateAgeOfOldestMessage",
                  Dimensions: [
                    {
                      Name: "QueueName",
                      Value: "some-other-queue",
                    },
                  ],
                  ComparisonOperator: "GreaterThanThreshold",
                },
              ],
            })
          : healthyAws()(args),
    });
    expect(byName(results, "DLQ CloudWatch alarm configured").status).toBe(
      "FAIL",
    );
  });

  it("fails when the ingest endpoint 404s (route not deployed)", async () => {
    const results = await run({
      fetch: (async () =>
        new Response("nope", { status: 404 })) as typeof fetch,
    });
    expect(
      byName(results, "ingest endpoint reachable and fails closed").status,
    ).toBe("FAIL");
  });

  it("fails when the endpoint redirects instead of terminating", async () => {
    const results = await run({
      fetch: (async () => new Response("", { status: 302 })) as typeof fetch,
    });
    const check = byName(results, "ingest endpoint reachable and fails closed");
    expect(check.status).toBe("FAIL");
    expect(check.detail).toContain("redirect");
  });

  it("reports MANUAL when GuardDuty is not API-visible", async () => {
    const results = await run({
      aws: (args) =>
        args[1] === "list-malware-protection-plans"
          ? fail("AccessDenied")
          : healthyAws()(args),
    });
    expect(byName(results, "GuardDuty protection plan").status).toBe("MANUAL");
  });
});
