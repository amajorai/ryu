import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

// The web entries promise not to load the bundled catalogs, the zip codec or a
// schema library. Walk their runtime import edges (type-only imports erase) and
// fail when one reaches a module that would pull them into a bundle.

const SOURCE_DIR = import.meta.dir;
const STATEMENT =
	/(?:^|\n)\s*(import|export)\s+(type\s+)?([^;]*?)\s*from\s+"([^"]+)"/gu;

const CATALOG_MODULES = [
	"archive.ts",
	"core.ts",
	"index.ts",
	"literal-translations.ts",
	"locales.ts",
	"login-locales.ts",
	"messages.ts",
	"react-provider.tsx",
];
const HEAVY_PACKAGES = ["fflate", "zod"];

function isTypeOnly(typeKeyword: string | undefined, clause: string): boolean {
	if (typeKeyword) {
		return true;
	}
	const named = clause.match(/^\{([\s\S]*)\}$/u)?.[1];
	if (named === undefined) {
		return false;
	}
	const specifiers = named
		.split(",")
		.map((specifier) => specifier.trim())
		.filter(Boolean);
	return (
		specifiers.length > 0 &&
		specifiers.every((specifier) => specifier.startsWith("type "))
	);
}

function runtimeImports(file: string): string[] {
	const source = readFileSync(join(SOURCE_DIR, file), "utf8");
	const imports: string[] = [];
	for (const match of source.matchAll(STATEMENT)) {
		const [, , typeKeyword, clause = "", specifier = ""] = match;
		if (!isTypeOnly(typeKeyword, clause.trim())) {
			imports.push(specifier);
		}
	}
	return imports;
}

function reachable(entry: string): Set<string> {
	const seen = new Set<string>();
	const queue = [entry];
	while (queue.length > 0) {
		const file = queue.pop() as string;
		if (seen.has(file)) {
			continue;
		}
		seen.add(file);
		for (const specifier of runtimeImports(file)) {
			if (specifier.startsWith("./")) {
				queue.push(join(dirname(file), specifier));
			} else {
				seen.add(specifier);
			}
		}
	}
	return seen;
}

describe("catalog-free entries", () => {
	for (const entry of [
		"lite.ts",
		"react-lite.tsx",
		"react-context.tsx",
		"react-provider-base.tsx",
		"react-text.tsx",
		"react-rich-text.tsx",
		"official-catalog.ts",
		"account-locale.ts",
	]) {
		test(`${entry} never reaches the bundled catalogs, fflate or zod`, () => {
			const modules = reachable(entry);
			for (const forbidden of [...CATALOG_MODULES, ...HEAVY_PACKAGES]) {
				expect(modules.has(forbidden)).toBe(false);
			}
			expect(modules.has("en-messages.ts")).toBe(true);
		});
	}

	test("the walk does see the catalogs behind the bundled entries", () => {
		expect(reachable("react-provider.tsx").has("locales.ts")).toBe(true);
		expect(reachable("core.ts").has("fflate")).toBe(true);
	});

	test("@ryu/i18n/react only re-exports, so its hooks never load the provider", () => {
		const source = readFileSync(join(SOURCE_DIR, "react.tsx"), "utf8");
		const code = source
			.replace(/\/\/[^\n]*/gu, "")
			.replace(STATEMENT, "")
			.replace(/;/gu, "")
			.trim();
		expect(code).toBe("");
	});
});
