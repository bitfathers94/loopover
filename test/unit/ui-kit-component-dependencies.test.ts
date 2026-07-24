import { readFileSync, readdirSync } from "node:fs";
import { builtinModules } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// #8309: @loopover/ui-kit is a real published npm package, and every external library its components
// import must be declared in its own package.json -- otherwise the import only resolves by accident of
// npm-workspace hoisting inside this monorepo (form.tsx imported react-hook-form with no manifest entry,
// so installing the package in isolation, or from a workspace member that doesn't hoist react-hook-form,
// left the import unresolved). This guards the whole class: any future component wrapping a new library
// without declaring it fails here.

const uiKitRoot = join(process.cwd(), "packages/loopover-ui-kit");
const componentsDir = join(uiKitRoot, "src/components");

type PackageManifest = {
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

const manifest = JSON.parse(
  readFileSync(join(uiKitRoot, "package.json"), "utf8"),
) as PackageManifest;

// A runtime import is satisfied by either a real dependency or a peerDependency (react/react-dom the
// consumer supplies). devDependencies deliberately do NOT count -- a shipped component importing a
// dev-only package would still break for a real consumer, which is exactly the gap this catches.
const declared = new Set<string>([
  ...Object.keys(manifest.dependencies ?? {}),
  ...Object.keys(manifest.peerDependencies ?? {}),
]);

const nodeBuiltins = new Set<string>(builtinModules);

// Comments can legitimately contain the substring `from "..."` (state-views.tsx's JSDoc says
// `Distinguishes "..." from "the server answered with an error"`), so strip comments before scanning
// for import specifiers -- otherwise that prose reads as a phantom "the server answered..." dependency.
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

// Reduce a module specifier to its installable package name: `@scope/name/sub` -> `@scope/name`,
// `name/sub` -> `name`.
function toPackageName(specifier: string): string {
  if (specifier.startsWith("@")) {
    return specifier.split("/").slice(0, 2).join("/");
  }
  return specifier.split("/")[0] ?? specifier;
}

function externalImports(source: string): Set<string> {
  const stripped = stripComments(source);
  const specifiers = new Set<string>();
  const patterns = [
    /\bfrom\s*["']([^"']+)["']/g, // import ... from "x" / export ... from "x"
    /\bimport\s+["']([^"']+)["']/g, // side-effect import "x"
    /\bimport\s*\(\s*["']([^"']+)["']/g, // dynamic import("x")
  ];
  for (const pattern of patterns) {
    for (const match of stripped.matchAll(pattern)) {
      const specifier = match[1];
      if (!specifier) continue;
      // Relative/absolute paths resolve within the package itself, not to a declared dependency.
      if (specifier.startsWith(".") || specifier.startsWith("/")) continue;
      const name = toPackageName(specifier);
      if (name.startsWith("node:") || nodeBuiltins.has(name)) continue;
      specifiers.add(name);
    }
  }
  return specifiers;
}

const componentFiles = readdirSync(componentsDir)
  .filter((name) => name.endsWith(".tsx") && !name.endsWith(".test.tsx"))
  .sort();

describe("@loopover/ui-kit component dependency manifest (#8309)", () => {
  it("has component source files to check", () => {
    expect(componentFiles.length).toBeGreaterThan(0);
  });

  it("declares react-hook-form, the dependency form.tsx imports", () => {
    const formImports = externalImports(
      readFileSync(join(componentsDir, "form.tsx"), "utf8"),
    );
    expect(formImports.has("react-hook-form")).toBe(true);
    expect(declared.has("react-hook-form")).toBe(true);
  });

  it("declares every external package its components import", () => {
    const missing: Record<string, string[]> = {};
    for (const file of componentFiles) {
      const source = readFileSync(join(componentsDir, file), "utf8");
      for (const pkg of externalImports(source)) {
        if (!declared.has(pkg)) {
          (missing[pkg] ??= []).push(file);
        }
      }
    }
    // Empty object on success; on failure the message names each undeclared package and where it's imported.
    expect(missing).toEqual({});
  });
});
