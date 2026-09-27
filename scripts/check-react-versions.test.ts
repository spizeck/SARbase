import { describe, expect, it } from "vitest";

// @ts-expect-error -- plain-JS guard script; no type declarations.
import { reactVersionProblems, specMajor } from "./check-react-versions.mjs";

const aligned = {
  dependencies: { react: "19.2.8", "react-dom": "19.2.8" },
  devDependencies: { "@types/react": "^19", "@types/react-dom": "^19" },
};

describe("specMajor", () => {
  it("extracts the major from unambiguous single-major specs", () => {
    expect(specMajor("19.2.8")).toBe(19);
    expect(specMajor("19")).toBe(19);
    expect(specMajor("^19")).toBe(19);
    expect(specMajor("^19.2.8")).toBe(19);
    expect(specMajor("~19.1.0")).toBe(19);
    expect(specMajor("19.x")).toBe(19);
    expect(specMajor("  ^20.0.0  ")).toBe(20);
  });

  it("rejects specs that do not resolve to exactly one major", () => {
    for (const spec of [
      ">=19 <21", // multi-major range
      ">=19", // open-ended range
      "<20",
      "19 - 20", // hyphen range
      "^19 || ^20",
      "*",
      "x",
      "19.x.x || 20.x",
      "latest", // dist-tag
      "next",
      "npm:react@19", // alias
      "workspace:*",
      "file:../react",
      "https://example.com/react.tgz",
      "",
    ]) {
      expect(specMajor(spec)).toBeNull();
    }
  });
});

describe("reactVersionProblems", () => {
  it("accepts an aligned React family", () => {
    expect(reactVersionProblems(aligned)).toEqual([]);
  });

  it("accepts a package that is not a React app", () => {
    expect(reactVersionProblems({ dependencies: { next: "16.0.0" } })).toEqual(
      [],
    );
  });

  it("rejects react without react-dom and vice versa", () => {
    expect(
      reactVersionProblems({ dependencies: { react: "19.2.8" } }).length,
    ).toBeGreaterThan(0);
    expect(
      reactVersionProblems({ dependencies: { "react-dom": "19.2.8" } }).length,
    ).toBeGreaterThan(0);
  });

  it("rejects react/react-dom version drift", () => {
    const problems = reactVersionProblems({
      dependencies: { react: "19.2.8", "react-dom": "19.1.0" },
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("react");
    expect(problems[0]).toContain("react-dom");
  });

  it("rejects a @types major that diverges from the react major", () => {
    const problems = reactVersionProblems({
      dependencies: { react: "19.2.8", "react-dom": "19.2.8" },
      devDependencies: { "@types/react": "^20", "@types/react-dom": "^19" },
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("@types/react");
  });

  it("rejects a @types/react-dom major that diverges", () => {
    const problems = reactVersionProblems({
      dependencies: { react: "19.2.8", "react-dom": "19.2.8" },
      devDependencies: { "@types/react": "^19", "@types/react-dom": "^18" },
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("@types/react-dom");
  });

  it("rejects multi-major ranges even when react/react-dom are equal", () => {
    const problems = reactVersionProblems({
      dependencies: { react: ">=19 <21", "react-dom": ">=19 <21" },
    });
    expect(problems.length).toBeGreaterThan(0);
    expect(problems[0]).toContain("exactly one major");
  });

  it("rejects tags, aliases, and wildcards instead of guessing a major", () => {
    for (const spec of ["latest", "npm:react@19", "*", ">=19"]) {
      const problems = reactVersionProblems({
        dependencies: { react: spec, "react-dom": spec },
      });
      expect(problems.length).toBeGreaterThan(0);
      expect(problems[0]).toContain("exactly one major");
    }
  });

  it("accepts caret/tilde/exact specs and still enforces the rest", () => {
    expect(
      reactVersionProblems({
        dependencies: { react: "^19.2.8", "react-dom": "^19.2.8" },
        devDependencies: {
          "@types/react": "~19.2",
          "@types/react-dom": "19.x",
        },
      }),
    ).toEqual([]);
    // Equal caret specs, wrong types major:
    expect(
      reactVersionProblems({
        dependencies: { react: "^19", "react-dom": "^19" },
        devDependencies: { "@types/react": "^20" },
      }),
    ).toHaveLength(1);
  });
});
