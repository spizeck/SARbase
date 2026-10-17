/**
 * Read-only GuardDuty scan-delivery verification (issue #20).
 *
 * Confirms the AWS delivery stack described in
 * runbooks/guardduty-scan-activation.md is actually wired — without
 * changing anything and without printing secrets. Every check is a
 * read-only AWS CLI call run under the OPERATOR'S OWN credentials; the
 * script never touches tokens, connection secrets, or bucket objects.
 *
 * Expected values come from infra/guardduty-scan-events.yaml — a
 * resource that exists but is wired to the wrong sibling resource is a
 * FAIL, not a pass, so every check validates names/fields, not just
 * existence.
 *
 * Usage:
 *   npx tsx scripts/guardduty-verify.ts \
 *     --region us-east-1 \
 *     --bucket sarbase-documents-prod-983902695382 \
 *     --env prod \
 *     --endpoint https://<domain>/api/internal/guardduty-scan-result
 *
 * Exit code 0 = every check returned PASS. 1 = at least one check
 * returned FAIL, MANUAL, or SKIP (verification incomplete — do not
 * treat the pipeline as confirmed).
 */

import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

interface CheckResult {
  name: string;
  status: "PASS" | "FAIL" | "MANUAL" | "SKIP";
  detail: string;
}

function arg(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

// Everything interpolated into an aws CLI argument must match a safe
// alphabet — values come from the operator's command line and run
// through a shell on Windows (aws CLI ships as aws.cmd there).
const SAFE_ARG = /^[a-zA-Z0-9][a-zA-Z0-9._/:-]*$/;

function assertSafeArg(name: string, value: string): string {
  if (!SAFE_ARG.test(value)) {
    throw new Error(
      `--${name} contains characters outside [a-zA-Z0-9._/:-]: refusing to interpolate it into a CLI call`,
    );
  }
  return value;
}

interface AwsResult {
  ok: boolean;
  json: unknown;
  stderr: string;
}

function aws(args: string[]): AwsResult {
  const result = spawnSync("aws", [...args, "--output", "json"], {
    env: process.env,
    encoding: "utf8",
    // Windows: aws is aws.cmd and needs a shell to resolve; every arg is
    // either a literal or passed assertSafeArg above, so no metachars
    // can reach the shell.
    shell: process.platform === "win32",
  });
  if (result.error) {
    return { ok: false, json: null, stderr: String(result.error) };
  }
  if (result.status !== 0) {
    return {
      ok: false,
      json: null,
      stderr: (result.stderr ?? "").trim().slice(0, 300),
    };
  }
  try {
    return { ok: true, json: JSON.parse(result.stdout ?? "null"), stderr: "" };
  } catch {
    return { ok: false, json: null, stderr: "unparseable CLI output" };
  }
}

function awsVersion(): boolean {
  const result = spawnSync("aws", ["--version"], {
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  return !result.error && result.status === 0;
}

export interface GuardDutyVerifyOptions {
  region: string;
  bucket: string;
  env?: string;
  endpoint?: string;
  aws?: typeof aws;
  awsVersion?: typeof awsVersion;
  fetch?: typeof fetch;
}

interface EventPattern {
  source?: string[];
  "detail-type"?: string[];
  detail?: {
    s3ObjectDetails?: {
      bucketName?: string[];
      objectKey?: ({ prefix?: string } | string)[];
    };
  };
}

function evaluateEventPattern(pattern: unknown, bucket: string): string | null {
  if (typeof pattern !== "object" || pattern === null) {
    return "pattern is not an object";
  }
  const p = pattern as EventPattern;
  if (!(p.source ?? []).includes("aws.guardduty")) {
    return 'source does not include "aws.guardduty"';
  }
  if (
    !(p["detail-type"] ?? []).includes(
      "GuardDuty Malware Protection Object Scan Result",
    )
  ) {
    return 'detail-type missing "GuardDuty Malware Protection Object Scan Result"';
  }
  const s3 = p.detail?.s3ObjectDetails;
  if (!(s3?.bucketName ?? []).includes(bucket)) {
    return `bucketName condition does not list ${bucket}`;
  }
  const hasPrefix = (s3?.objectKey ?? []).some(
    (k) => typeof k === "object" && k.prefix === "organizations/",
  );
  if (!hasPrefix) {
    return 'objectKey lacks the { prefix: "organizations/" } condition';
  }
  return null;
}

const EXPECTED_DETAIL_TYPE = "GuardDuty Malware Protection Object Scan Result";
const EXPECTED_PREFIX = "organizations/";
const EXPECTED_RETRY_ATTEMPTS = 10;
const EXPECTED_RETRY_AGE_S = 3600;
const EXPECTED_ALARM_METRIC = "ApproximateNumberOfMessagesVisible";

/** Runs every check and returns results — separated from process.exit
 *  so tests can exercise the whole matrix. */
export async function verifyGuardDutyDelivery(
  options: GuardDutyVerifyOptions,
): Promise<CheckResult[]> {
  const awsCli = options.aws ?? aws;
  const awsVersionFn = options.awsVersion ?? awsVersion;
  const fetchFn = options.fetch ?? fetch;
  const region = assertSafeArg("region", options.region);
  const bucket = assertSafeArg("bucket", options.bucket);
  const env = assertSafeArg("env", options.env ?? "prod");
  const { endpoint } = options;

  // Resource names follow infra/guardduty-scan-events.yaml conventions.
  const ruleName = `sarbase-${env}-guardduty-scan-result`;
  const destinationName = `sarbase-${env}-scan-ingest`;
  const connectionName = `sarbase-${env}-scan-webhook`;
  const dlqName = `sarbase-${env}-guardduty-scan-dlq`;
  const invokeRoleName = `sarbase-${env}-scan-event-invoke`;

  const results: CheckResult[] = [];
  const push = (r: CheckResult) => results.push(r);

  if (!awsVersionFn() || !awsCli(["sts", "get-caller-identity"]).ok) {
    push({
      name: "aws CLI available + authenticated",
      status: "FAIL",
      detail:
        "aws CLI unusable — install it and configure read-only credentials before running this script",
    });
    return results;
  }
  push({
    name: "aws CLI available + authenticated",
    status: "PASS",
    detail: "aws --version ok; sts get-caller-identity ok",
  });

  // Bucket versioning — scan events bind object versions, so a
  // non-versioned bucket can never reconcile a result.
  {
    const r = awsCli([
      "s3api",
      "get-bucket-versioning",
      "--bucket",
      bucket,
      "--region",
      region,
    ]);
    const status = r.ok ? (r.json as { Status?: string }).Status : null;
    push({
      name: "bucket versioning enabled",
      status: status === "Enabled" ? "PASS" : "FAIL",
      detail: r.ok
        ? `Status=${status ?? "(unset)"} — versioning is required for version-bound scan results`
        : r.stderr,
    });
  }

  // GuardDuty Malware Protection for S3 — the bucket must be a
  // protected resource on an ACTIVE plan with post-scan tagging on.
  {
    const plans = awsCli([
      "guardduty",
      "list-malware-protection-plans",
      "--region",
      region,
    ]);
    if (!plans.ok) {
      push({
        name: "GuardDuty protection plan",
        status: "MANUAL",
        detail:
          `list-malware-protection-plans failed (${plans.stderr}) — verify in ` +
          `GuardDuty console → Malware Protection for S3 that ${bucket} is protected and tagging is enabled`,
      });
    } else {
      const ids =
        (
          plans.json as {
            MalwareProtectionPlans?: { MalwareProtectionPlanId?: string }[];
          }
        ).MalwareProtectionPlans ?? [];
      let found: CheckResult | null = null;
      for (const p of ids) {
        if (!p.MalwareProtectionPlanId) continue;
        const detail = awsCli([
          "guardduty",
          "get-malware-protection-plan",
          "--malware-protection-plan-id",
          p.MalwareProtectionPlanId,
          "--region",
          region,
        ]);
        if (!detail.ok) continue;
        const plan = detail.json as {
          ProtectedResource?: { S3Bucket?: { BucketName?: string } };
          Actions?: { Tagging?: { Status?: string } };
          Status?: string;
        };
        if (plan.ProtectedResource?.S3Bucket?.BucketName !== bucket) continue;
        const active = plan.Status === "ACTIVE";
        const tagging = plan.Actions?.Tagging?.Status === "ENABLED";
        found = {
          name: "GuardDuty protection plan",
          status: active && tagging ? "PASS" : "FAIL",
          detail:
            `bucket protected; plan status=${plan.Status ?? "?"} ` +
            `(expected ACTIVE); tagging=${plan.Actions?.Tagging?.Status ?? "?"} ` +
            `(expected ENABLED — runbook Phase 3)`,
        };
        break;
      }
      push(
        found ?? {
          name: "GuardDuty protection plan",
          status: "FAIL",
          detail: `${ids.length} plan(s) in region — none covers ${bucket}`,
        },
      );
    }
  }

  // EventBridge rule — enabled, on the default bus, and the parsed
  // pattern must select exactly the events the endpoint accepts.
  {
    const r = awsCli([
      "events",
      "describe-rule",
      "--name",
      ruleName,
      "--region",
      region,
    ]);
    const rule = r.json as {
      State?: string;
      EventPattern?: string;
      EventBusName?: string;
    } | null;
    let patternError: string | null = null;
    if (r.ok && rule?.EventPattern) {
      try {
        patternError = evaluateEventPattern(
          JSON.parse(rule.EventPattern),
          bucket,
        );
      } catch {
        patternError = "EventPattern is not valid JSON";
      }
    }
    const bus = rule?.EventBusName ?? "default";
    push({
      name: "EventBridge rule enabled and scoped",
      status:
        r.ok && rule?.State === "ENABLED" && bus === "default" && !patternError
          ? "PASS"
          : "FAIL",
      detail: r.ok
        ? `state=${rule?.State ?? "?"} on bus ${bus}; pattern: ${patternError ?? `source aws.guardduty / "${EXPECTED_DETAIL_TYPE}" / ${bucket} / ${EXPECTED_PREFIX}`}`
        : r.stderr,
    });
  }

  // Rule targets — must point at THIS pipeline's destination, invoke
  // role, retry policy, and DLQ (any api-destination ARN is not enough).
  {
    const r = awsCli([
      "events",
      "list-targets-by-rule",
      "--rule",
      ruleName,
      "--region",
      region,
    ]);
    const targets =
      (
        r.json as {
          Targets?: {
            Arn?: string;
            RoleArn?: string;
            DeadLetterConfig?: { Arn?: string };
            RetryPolicy?: {
              MaximumRetryAttempts?: number;
              MaximumEventAgeInSeconds?: number;
            };
          }[];
        } | null
      )?.Targets ?? [];
    const t = targets[0];
    const problems: string[] = [];
    if (!r.ok) problems.push(r.stderr);
    if (!t) problems.push("no targets on the rule");
    if (t) {
      if (!t.Arn?.includes(`api-destination/${destinationName}`)) {
        problems.push(
          `target ARN ${t.Arn ?? "?"} is not the ${destinationName} api-destination`,
        );
      }
      if (!t.RoleArn?.endsWith(`role/${invokeRoleName}`)) {
        problems.push(`invoke role is not ${invokeRoleName}`);
      }
      if (!t.DeadLetterConfig?.Arn?.endsWith(dlqName)) {
        problems.push(`DLQ is not ${dlqName}`);
      }
      const retry = t.RetryPolicy;
      if (
        retry?.MaximumRetryAttempts !== EXPECTED_RETRY_ATTEMPTS ||
        retry?.MaximumEventAgeInSeconds !== EXPECTED_RETRY_AGE_S
      ) {
        problems.push(
          `retry policy ${JSON.stringify(retry ?? null)} != {attempts:${EXPECTED_RETRY_ATTEMPTS}, age:${EXPECTED_RETRY_AGE_S}s}`,
        );
      }
    }
    push({
      name: "rule targets wired to this pipeline",
      status: r.ok && problems.length === 0 ? "PASS" : "FAIL",
      detail:
        problems.length === 0
          ? `target → ${destinationName} via ${invokeRoleName}, bounded retry, DLQ ${dlqName}`
          : problems.join("; "),
    });
  }

  // API destination — ACTIVE, POST, pointed at the deployed app, and
  // bound to THIS pipeline's connection (the credential source).
  {
    const r = awsCli([
      "events",
      "describe-api-destination",
      "--name",
      destinationName,
      "--region",
      region,
    ]);
    const dest = r.json as {
      ApiDestinationState?: string;
      InvocationEndpoint?: string;
      HttpMethod?: string;
      ConnectionArn?: string;
    } | null;
    const problems: string[] = [];
    if (!r.ok) problems.push(r.stderr);
    if (r.ok) {
      if (dest?.ApiDestinationState !== "ACTIVE") {
        problems.push(`state=${dest?.ApiDestinationState ?? "?"} != ACTIVE`);
      }
      if (dest?.HttpMethod !== "POST") {
        problems.push(`HttpMethod=${dest?.HttpMethod ?? "?"} != POST`);
      }
      if (!dest?.ConnectionArn?.includes(`connection/${connectionName}/`)) {
        problems.push(`ConnectionArn not bound to ${connectionName}`);
      }
      if (endpoint && dest?.InvocationEndpoint !== endpoint) {
        problems.push(
          `endpoint=${dest?.InvocationEndpoint ?? "?"} != ${endpoint}`,
        );
      }
    }
    push({
      name: "API destination wired to the app",
      status: r.ok && problems.length === 0 ? "PASS" : "FAIL",
      detail:
        problems.length === 0
          ? `ACTIVE POST ${dest?.InvocationEndpoint ?? "?"} via ${connectionName}`
          : problems.join("; "),
    });
  }

  // Connection — AUTHORIZED with API_KEY auth (the template's bearer
  // header). The secret value is EventBridge-managed and never read.
  {
    const r = awsCli([
      "events",
      "describe-connection",
      "--name",
      connectionName,
      "--region",
      region,
    ]);
    const conn = r.json as {
      ConnectionState?: string;
      AuthType?: string;
    } | null;
    const problems: string[] = [];
    if (!r.ok) problems.push(r.stderr);
    if (r.ok) {
      if (conn?.ConnectionState !== "AUTHORIZED") {
        problems.push(`state=${conn?.ConnectionState ?? "?"} != AUTHORIZED`);
      }
      if (conn?.AuthType !== "API_KEY") {
        problems.push(`auth=${conn?.AuthType ?? "?"} != API_KEY`);
      }
    }
    push({
      name: "webhook connection authorized",
      status: r.ok && problems.length === 0 ? "PASS" : "FAIL",
      detail:
        problems.length === 0
          ? "AUTHORIZED + API_KEY (secret material is EventBridge-managed — not inspected)"
          : problems.join("; "),
    });
  }

  // DLQ — exists and is genuinely empty (visible + in-flight + delayed).
  {
    const url = awsCli([
      "sqs",
      "get-queue-url",
      "--queue-name",
      dlqName,
      "--region",
      region,
    ]);
    const queueUrl = url.ok
      ? (url.json as { QueueUrl?: string }).QueueUrl
      : undefined;
    if (!queueUrl) {
      push({
        name: "dead-letter queue exists and is empty",
        status: "FAIL",
        detail: url.ok ? "no QueueUrl returned" : url.stderr,
      });
    } else {
      const attrs = awsCli([
        "sqs",
        "get-queue-attributes",
        "--queue-url",
        queueUrl,
        "--attribute-names",
        "ApproximateNumberOfMessages",
        "ApproximateNumberOfMessagesNotVisible",
        "ApproximateNumberOfMessagesDelayed",
        "--region",
        region,
      ]);
      const a = attrs.ok
        ? ((attrs.json as { Attributes?: Record<string, string> }).Attributes ??
          {})
        : null;
      const visible = Number(a?.ApproximateNumberOfMessages ?? NaN);
      const inFlight = Number(a?.ApproximateNumberOfMessagesNotVisible ?? NaN);
      const delayed = Number(a?.ApproximateNumberOfMessagesDelayed ?? NaN);
      const total = (visible || 0) + (inFlight || 0) + (delayed || 0);
      push({
        name: "dead-letter queue exists and is empty",
        status: attrs.ok && total === 0 ? "PASS" : "FAIL",
        detail: attrs.ok
          ? `visible=${visible}, in-flight=${inFlight}, delayed=${delayed} (nonzero = delivery failures to investigate/replay)`
          : attrs.stderr,
      });
    }
  }

  // CloudWatch alarm — must alarm on THIS queue's visible messages.
  {
    const r = awsCli([
      "cloudwatch",
      "describe-alarms",
      "--alarm-names",
      dlqName,
      "--region",
      region,
    ]);
    const alarms =
      (
        r.json as {
          MetricAlarms?: {
            AlarmName?: string;
            StateValue?: string;
            Namespace?: string;
            MetricName?: string;
            Dimensions?: { Name?: string; Value?: string }[];
            Threshold?: number;
            ComparisonOperator?: string;
            EvaluationPeriods?: number;
          }[];
        } | null
      )?.MetricAlarms ?? [];
    const alarm = alarms[0];
    const problems: string[] = [];
    if (!r.ok) problems.push(r.stderr);
    if (r.ok && !alarm) problems.push(`no alarm named ${dlqName}`);
    if (alarm) {
      if (
        alarm.Namespace !== "AWS/SQS" ||
        alarm.MetricName !== EXPECTED_ALARM_METRIC
      ) {
        problems.push(
          `metric ${alarm.Namespace ?? "?"}/${alarm.MetricName ?? "?"} != AWS/SQS/${EXPECTED_ALARM_METRIC}`,
        );
      }
      if (
        !alarm.Dimensions?.some(
          (d) => d.Name === "QueueName" && d.Value === dlqName,
        )
      ) {
        problems.push(`not dimensioned on queue ${dlqName}`);
      }
      if (alarm.ComparisonOperator !== "GreaterThanThreshold") {
        problems.push(`operator=${alarm.ComparisonOperator ?? "?"}`);
      }
    }
    push({
      name: "DLQ CloudWatch alarm configured",
      status: r.ok && problems.length === 0 ? "PASS" : "FAIL",
      detail:
        problems.length === 0
          ? `alarms on ${dlqName} visible messages >0 (state=${alarm?.StateValue})`
          : problems.join("; "),
    });
  }

  // Live route probe — an unauthenticated POST must hit the auth gate
  // (401) or the not-configured gate (503). Redirects are FAILURES: the
  // configured destination must terminate on the app itself. A deadline
  // keeps a hung endpoint from blocking the whole report.
  if (endpoint) {
    try {
      const response = await fetchFn(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
        redirect: "manual",
        signal: AbortSignal.timeout(15_000),
      });
      const redirected = response.status >= 300 && response.status < 400;
      const gated = response.status === 401 || response.status === 503;
      push({
        name: "ingest endpoint reachable and fails closed",
        status: gated ? "PASS" : "FAIL",
        detail: redirected
          ? `POST → ${response.status} redirect — the destination must terminate on the app, not bounce`
          : `unauthenticated POST → ${response.status} (expected 401 auth gate or 503 not-configured; 404 means the route is not deployed)`,
      });
    } catch (error) {
      push({
        name: "ingest endpoint reachable and fails closed",
        status: "FAIL",
        detail: `probe failed: ${error instanceof Error ? error.message : error} — hung, unreachable, or TLS-broken`,
      });
    }
  } else {
    push({
      name: "ingest endpoint reachable and fails closed",
      status: "SKIP",
      detail:
        "pass --endpoint https://<domain>/api/internal/guardduty-scan-result to probe the live route",
    });
  }

  return results;
}

async function main() {
  const region = arg("--region") ?? process.env.AWS_REGION;
  const bucket = arg("--bucket");
  const endpoint = arg("--endpoint");
  const env = arg("--env") ?? "prod";

  if (!bucket || !region) {
    console.error(
      "Usage: npx tsx scripts/guardduty-verify.ts --region <r> --bucket <b> " +
        "[--env prod|preview] [--endpoint https://.../api/internal/guardduty-scan-result]",
    );
    return 2;
  }

  console.log(
    `GuardDuty scan-delivery verification — bucket ${bucket}, region ${region}, env ${env}`,
  );
  console.log("(read-only; no secrets are read or printed)\n");

  const results = await verifyGuardDutyDelivery({
    region,
    bucket,
    env,
    endpoint,
  });

  let incomplete = 0;
  for (const r of results) {
    if (r.status !== "PASS") incomplete += 1;
    console.log(`${r.status.padEnd(6)} ${r.name}: ${r.detail}`);
  }
  console.log(
    incomplete === 0
      ? "\nAll checks passed. Owner actions still required: live clean-file upload and EICAR threat test per runbook Phase 5."
      : `\n${incomplete} check(s) did not verify (FAIL/MANUAL/SKIP) — see runbooks/guardduty-scan-activation.md. The pipeline is NOT confirmed.`,
  );
  return incomplete === 0 ? 0 : 1;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().then((code) => process.exit(code));
}
