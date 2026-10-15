// Static assertions for infra/guardduty-scan-events.yaml.
//
// This is a unit test, not a deployment proof — it parses the template
// with a CloudFormation-tag-aware YAML schema and asserts the security-
// and correctness-critical structure AWS itself does not fully validate
// until deploy time (the three production rejections were all of this
// shape). cfn-lint in CI is the schema-level counterpart; together they
// keep unsupported properties, dangling references, and broken event
// patterns from silently entering the template.

import { readFileSync } from "node:fs";
import path from "node:path";

import yaml from "js-yaml";
import { describe, expect, it } from "vitest";

const TEMPLATE_PATH = path.join(__dirname, "guardduty-scan-events.yaml");

// CloudFormation short-form intrinsics (!Ref, !Sub, ...) are custom YAML
// tags; decode each into its long-form Fn::* marker object so tests can
// inspect them.
const CFN_FUNCTIONS = [
  "Base64",
  "Cidr",
  "FindInMap",
  "GetAtt",
  "GetAZs",
  "If",
  "ImportValue",
  "Join",
  "Not",
  "Equals",
  "Select",
  "Split",
  "Sub",
  "Transform",
] as const;

const cfnTypes = CFN_FUNCTIONS.flatMap((name) => [
  new yaml.Type(`!${name}`, {
    kind: "scalar",
    resolve: () => true,
    construct: (v) => ({ [`Fn::${name}`]: v }),
  }),
  new yaml.Type(`!${name}`, {
    kind: "sequence",
    resolve: () => true,
    construct: (v) => ({ [`Fn::${name}`]: v }),
  }),
]);
const cfnRef = new yaml.Type("!Ref", {
  kind: "scalar",
  resolve: () => true,
  construct: (v) => ({ Ref: v }),
});
const cfnSchema = yaml.JSON_SCHEMA.extend([...cfnTypes, cfnRef]);

export function loadTemplate() {
  return yaml.load(readFileSync(TEMPLATE_PATH, "utf8"), {
    schema: cfnSchema,
    filename: TEMPLATE_PATH,
  }) as Record<string, unknown>;
}

function resource(doc: Record<string, unknown>, name: string) {
  const res = (
    doc.Resources as Record<
      string,
      { Type: string; Properties?: Record<string, unknown> } | undefined
    >
  )[name];
  expect(res, `resource ${name} exists`).toBeDefined();
  return res!;
}

describe("guardduty-scan-events.yaml — template integrity", () => {
  const doc = loadTemplate();

  it("stays within CloudFormation's top-level Description limit", () => {
    const description = doc.Description as string;
    expect(typeof description).toBe("string");
    expect(description.length).toBeLessThanOrEqual(1024);
  });

  it("declares only resource types this stack intends to create", () => {
    const resources = doc.Resources as Record<string, { Type: string }>;
    for (const [name, res] of Object.entries(resources)) {
      expect(
        [
          "AWS::SQS::Queue",
          "AWS::SQS::QueuePolicy",
          "AWS::Events::Connection",
          "AWS::Events::ApiDestination",
          "AWS::IAM::Role",
          "AWS::Events::Rule",
          "AWS::CloudWatch::Alarm",
        ],
        `unexpected resource type on ${name}`,
      ).toContain(res.Type);
    }
  });

  it("every intrinsic reference resolves to a declared parameter or resource", () => {
    const declared = new Set([
      ...Object.keys(doc.Resources as object),
      ...Object.keys(doc.Parameters as object),
      "AWS::Region",
      "AWS::AccountId",
      "AWS::StackName",
    ]);
    const walk = (node: unknown) => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (node && typeof node === "object") {
        for (const [k, v] of Object.entries(node)) {
          if (k === "Ref" || k === "Fn::GetAtt" || k === "Fn::Sub") {
            if (k === "Fn::Sub" && typeof v === "string") {
              for (const m of v.matchAll(/\$\{([^}]+)\}/g)) {
                expect(
                  declared.has(m[1]!.split(".")[0]!),
                  `Sub target ${m[1]}`,
                ).toBe(true);
              }
            } else {
              // GetAtt appears as "Resource.Attr" scalar or
              // ["Resource", "Attr"] sequence; Ref is a plain name.
              const raw = Array.isArray(v) ? String(v[0]) : String(v);
              const target = raw.split(".")[0]!;
              expect(
                declared.has(target),
                `reference ${k} ${JSON.stringify(v)}`,
              ).toBe(true);
            }
          }
          walk(v);
        }
      }
    };
    walk(doc);
  });
});

describe("guardduty-scan-events.yaml — security-critical configuration", () => {
  const doc = loadTemplate();
  const res = (n: string) => resource(doc, n).Properties ?? {};

  it("filters the rule to the production bucket and attachment keys only", () => {
    const pattern = res("GuardDutyScanResultRule").EventPattern as Record<
      string,
      unknown
    >;
    expect(pattern.source).toEqual(["aws.guardduty"]);
    expect(pattern["detail-type"]).toEqual([
      "GuardDuty Malware Protection Object Scan Result",
    ]);
    const s3 = (pattern.detail as Record<string, unknown>)
      .s3ObjectDetails as Record<string, unknown>;
    expect(s3.bucketName).toEqual([{ Ref: "S3BucketName" }]);
    // Staging-object scan events must never reach the endpoint — they
    // would 400 (REJECTED_KEY), burn retries, and spam the DLQ.
    expect(s3.objectKey).toEqual([{ prefix: "organizations/" }]);
  });

  it("targets the authenticated ingest endpoint via POST", () => {
    const dest = res("ScanWebhookApiDestination");
    expect(dest.HttpMethod).toBe("POST");
    expect(dest.InvocationEndpoint).toEqual({
      "Fn::Sub": "${AppBaseUrl}/api/internal/guardduty-scan-result",
    });
    expect(dest.ConnectionArn).toEqual({
      "Fn::GetAtt": "ScanWebhookConnection.Arn",
    });
  });

  it("sends the shared token as `Authorization: Bearer <token>`", () => {
    const conn = res("ScanWebhookConnection");
    expect(conn.AuthorizationType).toBe("API_KEY");
    const apiKey = (conn.AuthParameters as Record<string, unknown>)
      .ApiKeyAuthParameters as Record<string, unknown>;
    expect(apiKey.ApiKeyName).toBe("Authorization");
    expect(apiKey.ApiKeyValue).toEqual({
      "Fn::Sub": "Bearer ${WebhookBearerToken}",
    });
  });

  it("keeps the bearer token out of stack outputs and console echoes", () => {
    const token = (doc.Parameters as Record<string, Record<string, unknown>>)
      .WebhookBearerToken!;
    expect(token.NoEcho).toBe(true);
    expect(token.MinLength).toBeGreaterThanOrEqual(32);
    // "Bearer " + token must fit the 512-char ApiKeyValue cap.
    expect(token.MaxLength).toBeLessThanOrEqual(505);
    const outputs = JSON.stringify(doc.Outputs);
    expect(outputs).not.toContain("WebhookBearerToken");
  });

  it("binds bounded retries and an SQS dead-letter queue to the target", () => {
    const targets = res("GuardDutyScanResultRule").Targets as Record<
      string,
      unknown
    >[];
    expect(targets).toHaveLength(1);
    const target = targets[0]!;
    expect(target.Arn).toEqual({
      "Fn::GetAtt": "ScanWebhookApiDestination.Arn",
    });
    expect(target.RoleArn).toEqual({
      "Fn::GetAtt": "ApiDestinationInvokeRole.Arn",
    });
    expect(target.RetryPolicy).toEqual({
      MaximumRetryAttempts: 10,
      MaximumEventAgeInSeconds: 3600,
    });
    expect(target.DeadLetterConfig).toEqual({
      Arn: { "Fn::GetAtt": "ScanEventDLQ.Arn" },
    });
  });

  it("grants the rule role only InvokeApiDestination on this destination", () => {
    const role = res("ApiDestinationInvokeRole");
    const statements = (
      role.Policies as { PolicyDocument: { Statement: unknown[] } }[]
    )[0]!.PolicyDocument.Statement;
    expect(statements).toEqual([
      {
        Effect: "Allow",
        Action: "events:InvokeApiDestination",
        Resource: { "Fn::GetAtt": "ScanWebhookApiDestination.ArnForPolicy" },
      },
    ]);
  });

  it("encrypts and retains the DLQ, and alarms on any parked message", () => {
    const dlq = res("ScanEventDLQ");
    expect(dlq.SqsManagedSseEnabled).toBe(true);
    expect(dlq.MessageRetentionPeriod).toBe(1209600);

    const alarm = res("ScanEventDLQAlarm");
    expect(alarm.MetricName).toBe("ApproximateNumberOfMessagesVisible");
    expect(alarm.ComparisonOperator).toBe("GreaterThanThreshold");
    expect(alarm.Threshold).toBe(0);
  });

  it("restricts DLQ writes to this stack's rule", () => {
    const policy = res("ScanEventDLQPolicy").PolicyDocument as {
      Statement: { Condition?: Record<string, unknown> }[];
    };
    const condition = policy.Statement[0]!.Condition!;
    expect(condition.ArnEquals).toEqual({
      "aws:SourceArn": { "Fn::GetAtt": "GuardDutyScanResultRule.Arn" },
    });
  });
});
