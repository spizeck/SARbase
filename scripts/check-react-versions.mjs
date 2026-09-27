import { readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// react and react-dom ship in lockstep and must declare the same version.
// Dependabot groups their updates but only bundles the releases available
// at that moment, so grouping alone cannot guarantee alignment — this check
// is the enforcement. Provenance: deepdivebrewing's
// scripts/check-react-versions.mjs, extended with @types/* major checks.
//
// Rules, evaluated against the merged dependency + devDependency specs:
//   1. A React app declares BOTH react and react-dom.
//   2. Their declared version specs are identical strings.
//   3. Every spec in the family resolves to exactly one major — exact,
//      `^X`, `~X`, and `X.x` forms are fine; ranges spanning majors,
//      tags, aliases, and other npm spec forms are rejected rather than
//      guessed at (the foundation wants a single unambiguous baseline).
//   4. Declared @types/react / @types/react-dom share the react major
//      (React 19 app must not sit on React 20 types, and vice versa).
// A template that declares neither is not a React app and is skipped.

/**
 * The single major an npm spec unambiguously allows, or null when the spec
 * is anything else (multi-major range, tag, alias, wildcard, URL, ...).
 * Deliberately not a semver engine — specs outside this shape are a
 * foundation-policy error, not a parsing problem.
 */
export function specMajor(spec) {
  const match = /^(?:\^|~)?(\d+)(?:\.[\dx*]+){0,2}$/.exec(
    String(spec ?? "").trim(),
  );
  return match ? Number(match[1]) : null;
}

/** @returns {string[]} human-readable mismatches; empty when aligned. */
export function reactVersionProblems(pkg) {
  const problems = [];
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const react = deps.react;
  const reactDom = deps["react-dom"];

  if (!react && !reactDom) {
    return problems; // not a React app — nothing to check
  }
  if (!react || !reactDom) {
    problems.push(
      "react and react-dom must both be declared; " +
        `found react=${JSON.stringify(react)}, react-dom=${JSON.stringify(reactDom)}.`,
    );
    return problems;
  }
  if (react !== reactDom) {
    problems.push(
      "react and react-dom must declare the same version spec: " +
        `react is "${react}", react-dom is "${reactDom}".`,
    );
  }

  const family = [
    ["react", react],
    ["react-dom", reactDom],
    ["@types/react", deps["@types/react"]],
    ["@types/react-dom", deps["@types/react-dom"]],
  ];
  for (const [name, spec] of family) {
    if (spec !== undefined && specMajor(spec) === null) {
      problems.push(
        `${name} must declare a spec resolving to exactly one major ` +
          `(e.g. "19.2.8", "^19", "~19.1"); got "${spec}".`,
      );
    }
  }

  // Major alignment is only comparable when both sides are unambiguous —
  // an unparseable spec already produced its own diagnostic above.
  const reactMajor = specMajor(react);
  const typesReactMajor = specMajor(deps["@types/react"]);
  if (
    reactMajor !== null &&
    typesReactMajor !== null &&
    typesReactMajor !== reactMajor
  ) {
    problems.push(
      "@types/react major must match the react major: " +
        `@types/react is "${deps["@types/react"]}", react is "${react}".`,
    );
  }
  const reactDomMajor = specMajor(reactDom);
  const typesReactDomMajor = specMajor(deps["@types/react-dom"]);
  if (
    reactDomMajor !== null &&
    typesReactDomMajor !== null &&
    typesReactDomMajor !== reactDomMajor
  ) {
    problems.push(
      "@types/react-dom major must match the react-dom major: " +
        `@types/react-dom is "${deps["@types/react-dom"]}", ` +
        `react-dom is "${reactDom}".`,
    );
  }
  return problems;
}

const invokedDirectly =
  process.argv[1] &&
  realpathSync(process.argv[1]) ===
    realpathSync(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

  const problems = reactVersionProblems(pkg);
  if (problems.length > 0) {
    for (const problem of problems) console.error(problem);
    process.exit(1);
  }
  console.log(
    `react family aligned (react=${pkg.dependencies?.react ?? "n/a"}).`,
  );
}
