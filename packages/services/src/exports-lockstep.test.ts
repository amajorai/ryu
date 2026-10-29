import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import packageJson from "../package.json";
import { ENTRIES } from "../tsup.config.ts";
import { NPM_PUBLISHED_VERSION, SDK_VERSION } from "./version.ts";

const PACKAGE_DIR = resolve(import.meta.dir, "..");

/** The package.json export path for a tsup entry key (`webhooks/index` -> `./webhooks`). */
function exportPathFor(entry: string): string {
	if (entry === "index") {
		return ".";
	}
	return `./${entry.replace(/\/index$/u, "")}`;
}

const VALUE_IMPORT =
	/^\s*(?:import|export)\s+(?!type\b)[^;]*?from\s+"([^"]+)"/gmu;

/** Relative modules reachable from `file` through value (non-type) imports. */
function importGraph(file: string, seen = new Set<string>()): Set<string> {
	if (seen.has(file)) {
		return seen;
	}
	seen.add(file);
	const source = readFileSync(file, "utf8");
	for (const match of source.matchAll(VALUE_IMPORT)) {
		const specifier = match[1] ?? "";
		if (specifier.startsWith(".")) {
			importGraph(resolve(dirname(file), specifier), seen);
		} else {
			seen.add(specifier);
		}
	}
	return seen;
}

function sourceFiles(dir: string): string[] {
	return readdirSync(dir, { recursive: true, withFileTypes: true })
		.filter(
			(entry) =>
				entry.isFile() &&
				entry.name.endsWith(".ts") &&
				!entry.name.endsWith(".test.ts")
		)
		.map((entry) => join(entry.parentPath, entry.name));
}

describe("package surface lockstep", () => {
	test("package.json exports equal the tsup entries", () => {
		const exported = Object.keys(packageJson.exports).sort();
		const entries = Object.keys(ENTRIES).map(exportPathFor).sort();
		expect(exported).toEqual(entries);
	});

	test("every export points at the tsup output of its entry", () => {
		for (const [entry, source] of Object.entries(ENTRIES)) {
			const target =
				packageJson.exports[
					exportPathFor(entry) as keyof typeof packageJson.exports
				];
			// Each condition carries its own types so a `require` consumer
			// gets the CJS declarations, not ESM types masquerading as CJS.
			expect(target).toEqual({
				import: {
					types: `./dist/${entry}.d.ts`,
					default: `./dist/${entry}.js`,
				},
				require: {
					types: `./dist/${entry}.d.cts`,
					default: `./dist/${entry}.cjs`,
				},
			});
			expect(existsSync(join(PACKAGE_DIR, source))).toBe(true);
		}
		expect(packageJson.main).toBe("./dist/index.cjs");
		expect(packageJson.types).toBe("./dist/index.d.ts");
	});

	test("the tarball ships dist and README only, and declares its Node floor", () => {
		expect(packageJson.files).toEqual(["dist", "README.md"]);
		expect(packageJson.engines).toEqual({ node: ">=18.17" });
	});

	test("version.ts matches package.json and the package is unpublished", () => {
		expect(SDK_VERSION).toBe(packageJson.version);
		expect(NPM_PUBLISHED_VERSION).toBeNull();
	});

	test("dependencies are exactly the design's: @ryuhq/client and zod", () => {
		expect(packageJson.dependencies).toEqual({
			"@ryuhq/client": "workspace:*",
			zod: "catalog:",
		});
		expect(
			packageJson.peerDependenciesMeta["@react-email/render"].optional
		).toBe(true);
	});

	test("the fetch shim uses @ryuhq/client's path scan instead of a copy", () => {
		const source = readFileSync(
			join(PACKAGE_DIR, "src/transport/fetch-shim.ts"),
			"utf8"
		);
		expect(source).toMatch(
			/^import \{[^}]*\bisSafeRequestPath\b[^}]*\} from "@ryuhq\/client";$/mu
		);
		// A second dot-segment scan would drift from the client's again.
		expect(source).not.toContain("DOT_SEGMENT");
		expect(source).not.toContain("function trimUrlEdges");
	});

	test("published source never imports apps/* or apps-store/*", () => {
		for (const file of sourceFiles(join(PACKAGE_DIR, "src"))) {
			const source = readFileSync(file, "utf8");
			expect({
				file: relative(PACKAGE_DIR, file),
				leaks: /from\s+"(?:\.\.\/)+apps(?:-store)?\//u.test(source),
			}).toEqual({
				file: relative(PACKAGE_DIR, file),
				leaks: false,
			});
		}
	});

	test("the root entry re-exports every resource-namespace table and type", async () => {
		const root = (await import("./index.ts")) as Record<string, unknown>;
		const rootSource = readFileSync(join(PACKAGE_DIR, "src/index.ts"), "utf8");
		for (const service of ["mail", "notify", "box"]) {
			const file = join(PACKAGE_DIR, "src", service, "namespace.ts");
			const module = (await import(file)) as Record<string, unknown>;
			const tables = Object.keys(module).filter((name) =>
				/_(?:CANONICAL_METHODS|TOP_LEVEL_METHODS|DEPRECATED_ALIASES)$/u.test(
					name
				)
			);
			expect(tables.length).toBeGreaterThan(0);
			for (const name of tables) {
				expect({ name, value: root[name] }).toEqual({
					name,
					value: module[name],
				});
			}
			const types = [
				...readFileSync(file, "utf8").matchAll(
					/^export (?:interface|type) (\w+(?:Namespace|NamespaceBase|FlatAliases|DeprecatedAlias))\b/gmu
				),
			].map((match) => match[1] ?? "");
			for (const name of types) {
				expect({
					name,
					exported: rootSource.includes(`type ${name},`),
				}).toEqual({ name, exported: true });
			}
		}
	});

	test("the errors and webhooks entries load no client code", () => {
		for (const entry of [ENTRIES.errors, ENTRIES["webhooks/index"]]) {
			const graph = importGraph(join(PACKAGE_DIR, entry));
			expect(
				[...graph].filter(
					(module) => module.startsWith("@ryuhq/") || module.startsWith("node:")
				)
			).toEqual([]);
		}
	});

	test("the tools entry depends on no agent framework", () => {
		const graph = importGraph(join(PACKAGE_DIR, ENTRIES["tools/index"]));
		const packages = [...graph].filter((module) => !module.startsWith("/"));
		// Structural adapters: no `ai`, no @ryuhq/sdk, no MCP SDK at runtime.
		expect(packages).toContain("zod");
		expect(
			packages.filter((name) => !["@ryuhq/client", "zod"].includes(name))
		).toEqual([]);
	});

	test("the root entry exports the tool-approval helpers and types", async () => {
		const root = (await import("./index.ts")) as Record<string, unknown>;
		for (const name of [
			"pendingToolApprovals",
			"toolApprovalIdempotencyKey",
			"TOOL_APPROVAL_EVENT_TYPES",
		]) {
			expect({ name, defined: root[name] !== undefined }).toEqual({
				name,
				defined: true,
			});
		}
	});

	test("tool modules reach the rest of the package only through tools/core.ts", async () => {
		const toolsDir = join(PACKAGE_DIR, "src/tools");
		const core = join(toolsDir, "core.ts");
		for (const file of sourceFiles(toolsDir)) {
			if (file === core) {
				continue;
			}
			const source = readFileSync(file, "utf8");
			for (const match of source.matchAll(VALUE_IMPORT)) {
				const target = resolve(dirname(file), match[1] ?? "");
				const outside =
					(match[1] ?? "").startsWith(".") &&
					!relative(toolsDir, target)
						.split("/")
						.every((part) => part !== "..");
				// A value import from outside src/tools would be bundled into
				// dist/tools instead of shared with the root entry.
				expect({ file: relative(PACKAGE_DIR, file), outside }).toEqual({
					file: relative(PACKAGE_DIR, file),
					outside: false,
				});
			}
		}
		// Every name core.ts re-exports is a root export, so the external
		// `@ryuhq/services` the build swaps in provides it.
		const root = (await import("./index.ts")) as Record<string, unknown>;
		const seam = (await import("./tools/core.ts")) as Record<string, unknown>;
		for (const name of Object.keys(seam)) {
			expect({ name, same: root[name] === seam[name] }).toEqual({
				name,
				same: true,
			});
		}
	});
});
