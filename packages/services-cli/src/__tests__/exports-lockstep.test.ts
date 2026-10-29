import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, resolve } from "node:path";
import packageJson from "../../package.json";
import tsupConfig, { ENTRIES } from "../../tsup.config.ts";
import * as surface from "../index.ts";
import { MCP_TOOL_MODULES } from "../mcp/registry.ts";
import { CLI_SERVICES } from "../registry.ts";
import { CLI_VERSION } from "../version.ts";

const PACKAGE_DIR = resolve(import.meta.dir, "../..");
const SRC_DIR = join(PACKAGE_DIR, "src");

const VALUE_IMPORT =
	/^\s*(?:import|export)\s+(?!type\b)[^;]*?from\s+"([^"]+)"/gmu;

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

/** `@scope/name/sub` gives `@scope/name`; `zod/v4` gives `zod`. */
function packageOf(specifier: string): string {
	const parts = specifier.split("/");
	return specifier.startsWith("@")
		? parts.slice(0, 2).join("/")
		: (parts[0] ?? "");
}

describe("package surface lockstep", () => {
	test("the library export and the bin are separate tsup entries", () => {
		expect(ENTRIES).toEqual({ index: "src/index.ts", bin: "src/bin.ts" });
		expect(Object.keys(packageJson.exports)).toEqual(["."]);
		expect(packageJson.exports["."]).toEqual({
			types: "./dist/index.d.ts",
			import: "./dist/index.js",
		});
		expect(packageJson.bin).toEqual({ "ryu-services": "./dist/bin.js" });
		expect(packageJson.main).toBe("./dist/index.js");
		expect(packageJson.types).toBe("./dist/index.d.ts");
		expect(packageJson.type).toBe("module");
		for (const entry of Object.values(ENTRIES)) {
			expect(existsSync(join(PACKAGE_DIR, entry))).toBe(true);
		}
	});

	test("only the bin is built with a shebang; both builds target node ESM", () => {
		const configs = tsupConfig as {
			banner?: { js?: string };
			entry?: Record<string, string>;
			format?: string[];
			platform?: string;
		}[];
		expect(configs.map((config) => config.entry)).toEqual([
			{ index: ENTRIES.index },
			{ bin: ENTRIES.bin },
		]);
		const [library, bin] = configs;
		expect(library?.banner).toBeUndefined();
		expect(bin?.banner?.js).toBe("#!/usr/bin/env node");
		for (const config of configs) {
			expect(config.format).toEqual(["esm"]);
			expect(config.platform).toBe("node");
		}
	});

	test("version.ts matches package.json", () => {
		expect(CLI_VERSION).toBe(packageJson.version);
	});

	test("the entry exports runCli, registerServiceTools and SERVICE_COMMANDS", () => {
		expect(typeof surface.runCli).toBe("function");
		expect(typeof surface.registerServiceTools).toBe("function");
		expect(typeof surface.createServicesMcpServer).toBe("function");
		expect(Object.keys(surface.SERVICE_COMMANDS).sort()).toEqual(
			CLI_SERVICES.map((entry) => entry.name).sort()
		);
		expect(surface.EXIT_CODES).toEqual({
			ok: 0,
			error: 1,
			usage: 2,
			webhookVerification: 4,
		});
	});

	test("the library entry has no side effects; only bin.ts runs the CLI", () => {
		const index = readFileSync(join(SRC_DIR, "index.ts"), "utf8");
		// Re-exports and comments only: no statement that could run on import.
		const statements = index
			.replace(/\/\/.*$/gmu, "")
			.split(";")
			.map((part) => part.trim())
			.filter(Boolean);
		for (const statement of statements) {
			expect(statement).toMatch(/^export\s/u);
		}
		expect(index).not.toContain("runCli(");
		expect(index).not.toContain("process.argv");
		const bin = readFileSync(join(SRC_DIR, "bin.ts"), "utf8");
		expect(bin).toContain("runCli(process.argv.slice(2))");
	});

	test("a command module per CLI service and a tool module per service with tools", () => {
		for (const entry of CLI_SERVICES) {
			expect(existsSync(join(SRC_DIR, "commands", `${entry.name}.ts`))).toBe(
				true
			);
		}
		for (const module of MCP_TOOL_MODULES) {
			const name = CLI_SERVICES.find(
				(entry) => entry.service === module.service
			)?.name;
			expect(existsSync(join(SRC_DIR, "mcp", "tools", `${name}.ts`))).toBe(
				true
			);
		}
		expect(MCP_TOOL_MODULES.map((module) => module.service)).not.toContain(
			"connect"
		);
	});

	test("source imports only declared dependencies and node builtins (never apps/*)", () => {
		const declared = new Set(Object.keys(packageJson.dependencies));
		const builtins = new Set(builtinModules);
		for (const file of sourceFiles(SRC_DIR)) {
			const source = readFileSync(file, "utf8");
			for (const match of source.matchAll(VALUE_IMPORT)) {
				const specifier = match[1] ?? "";
				if (specifier.startsWith(".")) {
					expect(resolve(dirname(file), specifier).startsWith(SRC_DIR)).toBe(
						true
					);
					continue;
				}
				const isBuiltin =
					specifier.startsWith("node:") || builtins.has(specifier);
				expect(isBuiltin || declared.has(packageOf(specifier))).toBe(true);
			}
		}
	});
});
