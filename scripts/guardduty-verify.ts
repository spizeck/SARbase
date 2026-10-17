/**
 * Read-only GuardDuty scan-delivery verification (issue #20).
 *
 * Confirms the AWS delivery stack described in
 * runbooks/guardduty-scan-activation.md is actually wired — without
 * changing anything and without printing secrets. Every check is a
 * read-only AWS CLI call run under the OPERATOR'S OWN credentials; the
 * script never touches tokens, connection secrets, or bucket objects.
 *
 * Usage:
 *   npx tsx scripts/guardduty-verify.ts \
 *     --region us-east-1 \
 *     --bucket sarbase-documents-prod-983902695382 \
 *     --env prod \
 *     --endpoint https://<domain>/api/internal/guardduty-scan-result
 *
 * Exit code 0 = every automated check passed. 1 = at least one FAIL.
 * Checks that cannot be verified by CLI print MANUAL with the exact
 * console location instead of guessing.
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

interface AwsResult {
  ok: boolean;
  json: unknown;
  stderr: string;
}

function aws(args: string[]): AwsResult {
  const result = spawnSync("aws", [...args, "--output", "json"], {
    env: process.env,
    encoding: "utf8",
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

export interface GuardDutyVerifyOptions {
  region: string;
  bucket: string;
  env?: string;
  endpoint?: string;
  aws?: typeof aws;
  fetch?: typeof fetch;
}

/** Runs every check and returns results — separated from process.exit
 *  so tests can exercise the whole matrix. */
export async function verifyGuardDutyDelivery(
  options: GuardDutyVerifyOptions,
): Promise<CheckResult[]> {
  const awsCli = options.aws ?? aws;
  const fetchFn = options.fetch ?? fetch;
  const { region, bucket, endpoint } = options;
  const env = options.env ?? "prod";

  // Resource names follow infra/guardduty-scan-events.yaml conventions.
  const ruleName = `sarbase-${env}-guardduty-scan-result`;
  const destinationName = `sarbase-${env}-scan-ingest`;
  const connectionName = `sarbase-${env}-scan-webhook`;
  const dlqName = `sarbase-${env}-guardduty-scan-dlq`;

  const results: CheckResult[] = [];
  const push = (r: CheckResult) => results.push(r);

  const version = spawnSync("aws", ["--version"], {
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  const identity = awsCli(["sts", "get-caller-identity"]);
  if (version.error || !identity.ok) {
    push({
      name: "aws CLI available + authenticated",
      status: "FAIL",
      detail:
        version.error || !identity.ok
          ? `aws CLI unusable (${version.error ?? identity.stderr}) — install it and configure read-only credentials`
          : "unreachable",
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

  // GuardDuty Malware Protection for S3 — the bucket must be listed as
  // a protected resource; tagging enables the reconcile path.
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
          `GuardDuty console → Malware Protection for S3 that ${bucket} is protected`,
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
        if (plan.ProtectedResource?.S3Bucket?.BucketName === bucket) {
          found = {
            name: "GuardDuty protection plan",
            status: "PASS",
            detail:
              `bucket protected; plan status=${plan.Status ?? "?"}; ` +
              (plan.Actions?.Tagging?.Status === "ENABLED"
                ? "post-scan tagging ENABLED"
                : "post-scan tagging NOT enabled — see runbook Phase 3"),
          };
          break;
        }
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

  // EventBridge rule — enabled, on the expected pattern.
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
    const pattern = rule?.EventPattern ?? "";
    const scoped =
      pattern.includes(bucket) && pattern.includes("organizations/");
    push({
      name: "EventBridge rule enabled and scoped",
      status: r.ok && rule?.State === "ENABLED" && scoped ? "PASS" : "FAIL",
      detail: r.ok
        ? `state=${rule?.State ?? "?"} on bus ${rule?.EventBusName ?? "?"}; pattern covers ${bucket} + organizations/ prefix: ${scoped}`
        : r.stderr,
    });
  }

  // Rule targets — API destination with invoke role and DLQ.
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
          }[];
        } | null
      )?.Targets ?? [];
    const t = targets[0];
    const isApiDest = t?.Arn?.includes("api-destination") ?? false;
    const ok =
      r.ok &&
      isApiDest &&
      Boolean(t?.RoleArn) &&
      Boolean(t?.DeadLetterConfig?.Arn);
    push({
      name: "rule targets API destination with invoke role + DLQ",
      status: ok ? "PASS" : "FAIL",
      detail: r.ok
        ? `targets=${targets.length}; api-destination=${isApiDest}, invoke role=${Boolean(t?.RoleArn)}, DLQ=${Boolean(t?.DeadLetterConfig?.Arn)}`
        : r.stderr,
    });
  }

  // API destination — authorized and pointed at the deployed app.
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
      ConnectionState?: string;
      InvocationEndpoint?: string;
    } | null;
    const endpointMatches = endpoint
      ? dest?.InvocationEndpoint === endpoint
      : true;
    push({
      name: "API destination authorized and pointed at the app",
      status:
        r.ok && dest?.ConnectionState === "AUTHORIZED" && endpointMatches
          ? "PASS"
          : "FAIL",
      detail: r.ok
        ? `state=${dest?.ConnectionState ?? "?"}; endpoint=${dest?.InvocationEndpoint ?? "?"}` +
          (endpoint && !endpointMatches ? ` — expected ${endpoint}` : "")
        : r.stderr,
    });
  }

  // Connection — authorized. The secret value lives in an
  // EventBridge-managed secret and is never inspected.
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
    push({
      name: "webhook connection authorized",
      status: r.ok && conn?.ConnectionState === "AUTHORIZED" ? "PASS" : "FAIL",
      detail: r.ok
        ? `state=${conn?.ConnectionState ?? "?"}; auth=${conn?.AuthType ?? "?"} (secret material is EventBridge-managed — not inspected)`
        : r.stderr,
    });
  }

  // DLQ — exists and holds no undelivered events.
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
        "--region",
        region,
      ]);
      const count = attrs.ok
        ? Number(
            (attrs.json as { Attributes?: Record<string, string> }).Attributes
              ?.ApproximateNumberOfMessages ?? "0",
          )
        : NaN;
      push({
        name: "dead-letter queue exists and is empty",
        status: count === 0 ? "PASS" : "FAIL",
        detail: `queue exists; visible messages=${Number.isNaN(count) ? "unknown" : count} (nonzero = delivery failures to investigate)`,
      });
    }
  }

  // CloudWatch alarm on the DLQ — terminal delivery failures page.
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
          MetricAlarms?: { AlarmName?: string; StateValue?: string }[];
        } | null
      )?.MetricAlarms ?? [];
    push({
      name: "DLQ CloudWatch alarm configured",
      status: r.ok && alarms.length > 0 ? "PASS" : "FAIL",
      detail: r.ok
        ? alarms.length > 0
          ? `alarm ${alarms[0]!.AlarmName} state=${alarms[0]!.StateValue}`
          : `no alarm named ${dlqName}`
        : r.stderr,
    });
  }

  // Live route probe — an unauthenticated POST must hit the auth gate
  // (401) or the not-configured gate (503). Anything else (404, hang,
  // redirect) means delivery would fail at the last hop.
  if (endpoint) {
    try {
      const response = await fetchFn(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      const ok = response.status === 401 || response.status === 503;
      push({
        name: "ingest endpoint reachable and fails closed",
        status: ok ? "PASS" : "FAIL",
        detail: `unauthenticated POST → ${response.status} (expected 401 auth gate or 503 not-configured; 404 means the route is not deployed)`,
      });
    } catch (error) {
      push({
        name: "ingest endpoint reachable and fails closed",
        status: "FAIL",
        detail: `fetch failed: ${error instanceof Error ? error.message : error}`,
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

  let failures = 0;
  for (const r of results) {
    if (r.status === "FAIL") failures += 1;
    console.log(`${r.status.padEnd(6)} ${r.name}: ${r.detail}`);
  }
  console.log(
    failures === 0
      ? "\nAll automated checks passed. Owner actions still required: live clean-file upload and EICAR threat test per runbook Phase 5."
      : `\n${failures} check(s) FAILED — see runbooks/guardduty-scan-activation.md for the fix and rollback guidance.`,
  );
  return failures === 0 ? 0 : 1;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().then((code) => process.exit(code));
}
