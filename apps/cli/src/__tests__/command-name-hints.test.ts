// The terminal client installs as `ryu-cli`; `ryu` is the SDK binary, which has
// no `secrets`, `login`, or `logout` command. A hint or doc example that says
// `ryu secrets …` fails with "unknown command" when a user pastes it, so this
// guard keeps the copyable command name in sync across the CLI and the docs.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..");
const CLI_SOURCE = join(REPO_ROOT, "apps", "cli", "src");
const DOCS_CONTENT = join(REPO_ROOT, "apps", "fumadocs", "content");

const CLI_HINT = /(?<![\w-])ryu (?:secrets|login|logout)\b/;
const DOCS_HINT = /(?<![\w-])ryu secrets\b/;

// Files that still print or document `ryu secrets`. Each is over the staged
// file-size limit (tools/check-file-limits.mjs), or its assertions live in a test
// file that is, so the rename lands when the file is split. Remove an entry once
// its hints say `ryu-cli`; never add one.
const PENDING_SPLIT = new Set([
	"apps/cli/src/cli/migrate.ts",
	"apps/cli/src/cli/secrets.ts",
	"apps/cli/src/cli/vaultStepUp.ts",
	"apps/fumadocs/content/docs/security/secret-vault.mdx",
	"apps/fumadocs/content/docs/surfaces/cli/reference.mdx",
	"apps/fumadocs/content/docs/surfaces/cli/tui.mdx",
]);

const isComment = (line: string) => /^\s*(?:\/\/|\/\*|\*)/.test(line);

function offendingLines(
	root: string,
	pattern: string,
	hint: RegExp,
	skipComments: boolean
): string[] {
	const found: string[] = [];
	for (const file of new Bun.Glob(pattern).scanSync({ cwd: root })) {
		const path = relative(REPO_ROOT, join(root, file)).replaceAll("\\", "/");
		if (PENDING_SPLIT.has(path) || path.includes("/__tests__/")) {
			continue;
		}
		const content = readFileSync(join(root, file), "utf8");
		if (!content.includes("ryu ")) {
			continue;
		}
		for (const [index, line] of content.split("\n").entries()) {
			if (hint.test(line) && !(skipComments && isComment(line))) {
				found.push(`${path}:${index + 1}`);
			}
		}
	}
	return found;
}

test("CLI hints name the installed ryu-cli binary", () => {
	expect(offendingLines(CLI_SOURCE, "**/*.{ts,tsx}", CLI_HINT, true)).toEqual(
		[]
	);
});

// Reads every public page (about 2,400 files), which is slow on a busy disk.
const DOCS_SCAN_TIMEOUT_MS = 120_000;

test(
	"public docs show ryu-cli secrets commands",
	() => {
		expect(offendingLines(DOCS_CONTENT, "**/*.mdx", DOCS_HINT, false)).toEqual(
			[]
		);
	},
	DOCS_SCAN_TIMEOUT_MS
);

test("pending files still exist, so the exception list cannot go stale", () => {
	for (const path of PENDING_SPLIT) {
		expect(() => readFileSync(join(REPO_ROOT, path))).not.toThrow();
	}
});
