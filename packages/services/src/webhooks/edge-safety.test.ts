import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const WEBHOOKS_DIR = import.meta.dir;
const SPECIFIER = /\b(?:from|import)\s*\(?\s*["']([^"']+)["']/g;

/** Every non-test source file under src/webhooks. */
function sourceFiles(): string[] {
	return readdirSync(WEBHOOKS_DIR, { recursive: true, withFileTypes: true })
		.filter(
			(entry) =>
				entry.isFile() &&
				entry.name.endsWith(".ts") &&
				!entry.name.endsWith(".test.ts")
		)
		.map((entry) => join(entry.parentPath, entry.name));
}

/** Every specifier a file imports or re-exports, statically or dynamically. */
function specifiers(file: string): string[] {
	return [...readFileSync(file, "utf8").matchAll(SPECIFIER)].map(
		(match) => match[1] ?? ""
	);
}

/** The transitive module graph reachable from `file` through relative imports. */
function graph(file: string, seen = new Set<string>()): Set<string> {
	if (seen.has(file)) {
		return seen;
	}
	seen.add(file);
	for (const specifier of specifiers(file)) {
		if (specifier.startsWith(".")) {
			graph(resolve(dirname(file), specifier), seen);
		} else {
			seen.add(specifier);
		}
	}
	return seen;
}

describe("webhooks edge safety", () => {
	test("finds the webhook sources", () => {
		const names = sourceFiles().map((file) =>
			file.slice(WEBHOOKS_DIR.length + 1)
		);
		expect(names.sort()).toEqual([
			"crypto.ts",
			"handler.ts",
			"index.ts",
			"mail.ts",
			"messaging.ts",
			"notify.ts",
			"standard.ts",
		]);
	});

	test.each(sourceFiles())("%s imports no node: module", (file) => {
		expect(specifiers(file).filter((s) => s.startsWith("node:"))).toEqual([]);
	});

	test("the entry point's whole graph loads no node:, bare package or client code", () => {
		const reachable = [...graph(join(WEBHOOKS_DIR, "index.ts"))];
		expect(reachable.filter((module) => !module.startsWith("/"))).toEqual([]);
		for (const module of reachable) {
			const source = readFileSync(module, "utf8");
			expect({ module, usesBuffer: /\bBuffer\b/.test(source) }).toEqual({
				module,
				usesBuffer: false,
			});
			expect({ module, usesProcess: /\bprocess\./.test(source) }).toEqual({
				module,
				usesProcess: false,
			});
		}
	});

	test("the graph stays out of the client facade", () => {
		const reachable = [...graph(join(WEBHOOKS_DIR, "index.ts"))].map((module) =>
			module.slice(dirname(WEBHOOKS_DIR).length + 1)
		);
		for (const forbidden of ["ryu.ts", "wrap.ts", "config.ts", "env.ts"]) {
			expect(reachable).not.toContain(forbidden);
		}
	});
});
