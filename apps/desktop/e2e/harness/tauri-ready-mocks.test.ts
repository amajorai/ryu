import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

// Several Vite harnesses alias `@/src/lib/tauri-ready.ts` to a fixture module
// and still load the real auth client (lib/auth-client.ts) and entitlement hook
// (src/hooks/useEntitlement.ts). An export those modules import but the fixture
// lacks fails ESM linking in the browser ("does not provide an export named"),
// so the harness page never renders and every spec on it fails. This guard
// keeps each aliased fixture in step with what those modules import.

const desktopRoot = path.resolve(import.meta.dir, "../..");
const harnessDir = import.meta.dir;
const TAURI_READY = "@/src/lib/tauri-ready.ts";
const CONSUMERS = ["lib/auth-client.ts", "src/hooks/useEntitlement.ts"];

const IMPORT_PATTERN =
	/import\s*\{([^}]*)\}\s*from\s*"@\/src\/lib\/tauri-ready\.ts"/g;
const ALIAS_PATTERN =
	/find:\s*"@\/src\/lib\/tauri-ready\.ts",\s*replacement:\s*(path\.resolve\([^)]*\)|[A-Za-z_$][\w$]*)/g;
const HARNESS_PATH_PATTERN =
	/^path\.resolve\(\s*harnessDir,\s*"([^"]+)",?\s*\)$/;

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Runtime names a module imports from tauri-ready.ts (type-only ones skipped). */
function importedNames(source: string): string[] {
	const names: string[] = [];
	for (const match of source.matchAll(IMPORT_PATTERN)) {
		for (const specifier of (match[1] ?? "").split(",")) {
			const name = specifier.trim();
			if (name && !name.startsWith("type ")) {
				names.push(name.split(/\s+as\s+/)[0] ?? name);
			}
		}
	}
	return names;
}

/** The fixture file a config's `replacement:` expression points at. */
function resolveReplacement(config: string, expression: string): string {
	const binding = new RegExp(
		`const\\s+${escapeRegExp(expression)}\\s*=\\s*(path\\.resolve\\([^)]*\\))`
	).exec(config);
	const resolved = HARNESS_PATH_PATTERN.exec(binding?.[1] ?? expression);
	if (!resolved?.[1]) {
		throw new Error(`Cannot resolve tauri-ready replacement: ${expression}`);
	}
	return path.resolve(harnessDir, resolved[1]);
}

function exportsName(source: string, name: string): boolean {
	return new RegExp(
		`export\\s+(?:async\\s+)?(?:function|class|const|let)\\s+${escapeRegExp(name)}\\b`
	).test(source);
}

const required = [
	...new Set(
		CONSUMERS.flatMap((file) =>
			importedNames(readFileSync(path.join(desktopRoot, file), "utf8"))
		)
	),
].sort();

const aliasedFixtures = new Map<string, string[]>();
for (const file of readdirSync(harnessDir)) {
	if (!/^vite\..+\.config\.ts$/.test(file)) {
		continue;
	}
	const config = readFileSync(path.join(harnessDir, file), "utf8");
	for (const match of config.matchAll(ALIAS_PATTERN)) {
		const fixture = resolveReplacement(config, match[1] ?? "");
		aliasedFixtures.set(fixture, [
			...(aliasedFixtures.get(fixture) ?? []),
			file,
		]);
	}
}

test("the consumers import the names this guard checks", () => {
	expect(required).toContain("isNoDesktopBackend");
	expect(required).toContain("invokeWhenReady");
});

test("the harness configs that alias tauri-ready.ts are all found", () => {
	expect(aliasedFixtures.size).toBeGreaterThanOrEqual(4);
});

test(`every fixture aliased for ${TAURI_READY} exports what the auth client and entitlement hook import`, () => {
	const missing: string[] = [];
	for (const [fixture, configs] of aliasedFixtures) {
		const source = readFileSync(fixture, "utf8");
		for (const name of required) {
			if (!exportsName(source, name)) {
				missing.push(
					`${path.basename(fixture)} (aliased by ${configs.join(", ")}) lacks ${name}`
				);
			}
		}
	}
	expect(missing).toEqual([]);
});
