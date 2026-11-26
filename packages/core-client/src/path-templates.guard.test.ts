// packages/core-client/src/path-templates.guard.test.ts
//
// A GUARD, not a proof of a fix. It reads the source text of this package and
// fails when a Core path template puts a value into the path without a known
// encoder, unless the file is on the OPEN LIST below with its reason and its
// exact count. A new unencoded interpolation anywhere makes it fail: outside
// the list because the file is not named, inside it because the count grows.
// A file that gets fixed must leave the list (or lower its count) in the same
// commit, so the list only shrinks.
//
// What it reads: every template literal that starts with `/<letter>` or with
// `${UPPER_CASE_BASE}/`, on one line, in every non-test `.ts` file under src/.
// What it judges: each `${...}` before the first `?` or `#` of the template.
// A `${...}` in the query part is not judged (it cannot change the route).
// What it does not see: a path built by string concatenation, a template that
// starts with a lower-case variable, and what a helper does with its argument.

import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = import.meta.dir;

/** Calls that keep a value inside one path segment. */
const ENCODER_CALL =
	/^(?:encodePathId|encodeMountPathId|encodeURIComponent|encodeAgentPathId|encode|id)\(/;
// `encode` is the local wrapper of harness.ts and `id` the one of
// vault-external.ts; both return encodeURIComponent(value).
const TEMPLATE_START = /`(?:\/[A-Za-z]|\$\{[A-Z][A-Z_]*\}\/)/g;
const BASE_CONSTANT = /^[A-Z][A-Z_]*$/;
const WHITESPACE = /\s/;
const SKIPPED_FOLDERS: ReadonlySet<string> = new Set([
	"__tests__",
	"test-support",
]);

interface OpenEntry {
	/** Unencoded path templates in the file today. */
	count: number;
	reason: string;
}

const OVER_LIMIT =
	"file over the hook limits (500 lines or 20,000 bytes), split first, then encodePathId";
const QUERY_SUFFIX =
	"a query suffix from a helper or a variable follows the last segment, not an id; the helpers were not read one by one";
const FIXED_WORD =
	"by its name the value is a fixed word of the code (action, op, decision, kind, route) or a query suffix, not a record id; read by name only, not traced";
const openEntry = (count: number, reason: string): OpenEntry => ({
	count,
	reason,
});

/**
 * THE OPEN LIST: files that still interpolate a path value without an encoder.
 * monitors.ts, workflows.ts and spaces.ts, the rest of SA-12 that held record
 * ids, left it when they were split and encoded (SA-15 part 2). OVER_LIMIT
 * stays the reason for a file that is too big to be encoded before a split.
 */
const OPEN_LIST: Readonly<Record<string, OpenEntry>> = {
	"app-request.ts": openEntry(
		2,
		"the mount of an app; an app id is a scoped name with a slash by design, so it cannot be one encoded segment; the caller check of the mount was not read again"
	),
	"plugins-sidecar.ts": openEntry(
		4,
		"sidecar name and a route word; no caller with an untrusted name found by the import grep of SA-12 step 0, not encoded in this change"
	),
	"vault/machine-logins.ts": openEntry(
		1,
		"the login method name of a machine login, a string argument; not traced, not encoded in this change"
	),
	"acp.ts": openEntry(1, QUERY_SUFFIX),
	"backups.ts": openEntry(2, QUERY_SUFFIX),
	"downloads.ts": openEntry(1, FIXED_WORD),
	"gateway.ts": openEntry(1, QUERY_SUFFIX),
	"mcp.ts": openEntry(1, QUERY_SUFFIX),
	"plugins.ts": openEntry(1, FIXED_WORD),
	"recaps.ts": openEntry(4, FIXED_WORD),
	"updates.ts": openEntry(1, QUERY_SUFFIX),
	"usage.ts": openEntry(2, QUERY_SUFFIX),
	"vault-events.ts": openEntry(2, QUERY_SUFFIX),
	"vault/agent-routes.ts": openEntry(4, FIXED_WORD),
	"vault/audit.ts": openEntry(1, QUERY_SUFFIX),
	"vault/broker.ts": openEntry(6, QUERY_SUFFIX),
	"vault/cards.ts": openEntry(1, QUERY_SUFFIX),
	"vault/change-requests.ts": openEntry(2, FIXED_WORD),
	"vault/control-groups.ts": openEntry(2, QUERY_SUFFIX),
	"vault/dynamic.ts": openEntry(2, FIXED_WORD),
	"vault/environments.ts": openEntry(2, QUERY_SUFFIX),
	"vault/internal.ts": openEntry(2, QUERY_SUFFIX),
	"vault/items.ts": openEntry(1, QUERY_SUFFIX),
	"vault/password-manager.ts": openEntry(5, FIXED_WORD),
	"vault/pki.ts": openEntry(1, FIXED_WORD),
	"vault/ssh.ts": openEntry(1, FIXED_WORD),
	"vault/tokens.ts": openEntry(4, FIXED_WORD),
	"vault/totp.ts": openEntry(2, FIXED_WORD),
	"vault/transit.ts": openEntry(1, FIXED_WORD),
	"vault/values.ts": openEntry(1, QUERY_SUFFIX),
};

interface Finding {
	file: string;
	template: string;
}

/** The index right after the `}` that closes the `${` whose body starts at `from`. */
function expressionEnd(line: string, from: number): number {
	let depth = 1;
	let index = from;
	while (index < line.length && depth > 0) {
		if (line[index] === "{") {
			depth += 1;
		} else if (line[index] === "}") {
			depth -= 1;
		}
		index += 1;
	}
	return index;
}

/**
 * Walk one template from the character after its opening backtick. Returns the
 * template text and the path-part expressions that are not an encoder call, or
 * null when the text holds a space (an error message, not a path).
 */
function readTemplate(
	line: string,
	start: number
): { text: string; unencoded: string[] } | null {
	const unencoded: string[] = [];
	let inQuery = false;
	let index = start;
	while (index < line.length && line[index] !== "`") {
		const character = line[index] ?? "";
		if (character === "$" && line[index + 1] === "{") {
			const end = expressionEnd(line, index + 2);
			const expression = line.slice(index + 2, end - 1).trim();
			const isBase = index === start && BASE_CONSTANT.test(expression);
			if (!(inQuery || isBase || ENCODER_CALL.test(expression))) {
				unencoded.push(expression);
			}
			index = end;
			continue;
		}
		if (WHITESPACE.test(character)) {
			return null;
		}
		if (character === "?" || character === "#") {
			inQuery = true;
		}
		index += 1;
	}
	return { text: line.slice(start - 1, index + 1), unencoded };
}

function scanText(file: string, text: string): Finding[] {
	const findings: Finding[] = [];
	for (const line of text.split("\n")) {
		for (const match of line.matchAll(TEMPLATE_START)) {
			const template = readTemplate(line, match.index + 1);
			if (template && template.unencoded.length > 0) {
				findings.push({ file, template: template.text });
			}
		}
	}
	return findings;
}

function sourceFiles(folder: string, prefix: string): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(folder, { withFileTypes: true })) {
		const relative = `${prefix}${entry.name}`;
		if (entry.isDirectory()) {
			if (!SKIPPED_FOLDERS.has(entry.name)) {
				files.push(...sourceFiles(join(folder, entry.name), `${relative}/`));
			}
		} else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
			files.push(relative);
		}
	}
	return files.sort();
}

function scanPackage(): Finding[] {
	return sourceFiles(SRC, "").flatMap((file) =>
		scanText(file, readFileSync(join(SRC, file), "utf8"))
	);
}

test("the scanner tells an encoded path value from an unencoded one", () => {
	// "@{" stands for the start of an interpolation in the samples.
	const source = (text: string) => text.replaceAll("@{", "${");
	const found = scanText(
		"sample.ts",
		source(
			[
				"a(`/api/x/@{id}`);",
				"a(`/api/x/@{encodePathId(id)}/y/@{other}`);",
				"a(`/api/x/@{encodePathId(id)}?limit=@{limit}`);",
				"a(`@{BASE}/x/@{encodeURIComponent(id)}`);",
				"a(`@{BASE}/x/@{id}`);",
				"throw new Error(`/api/x/@{id} failed: @{status}`);",
				"a(`/api/x@{suffix}`);",
			].join("\n")
		)
	);
	expect(found.map((finding) => finding.template)).toEqual(
		[
			"`/api/x/@{id}`",
			"`/api/x/@{encodePathId(id)}/y/@{other}`",
			"`@{BASE}/x/@{id}`",
			"`/api/x@{suffix}`",
		].map(source)
	);
});

test("no Core path template interpolates a value without an encoder outside the open list", () => {
	const byFile = new Map<string, string[]>();
	for (const finding of scanPackage()) {
		byFile.set(finding.file, [
			...(byFile.get(finding.file) ?? []),
			finding.template,
		]);
	}
	const unexpected: string[] = [];
	for (const [file, templates] of byFile) {
		const open = OPEN_LIST[file];
		if (!open) {
			unexpected.push(
				`${file} is not on the open list (${templates.length}): ${templates.join("  ")}`
			);
		} else if (templates.length !== open.count) {
			unexpected.push(
				`${file} has ${templates.length} unencoded path templates, the open list says ${open.count}: ${templates.join("  ")}`
			);
		}
	}
	for (const file of Object.keys(OPEN_LIST)) {
		if (!byFile.has(file)) {
			unexpected.push(
				`${file} is on the open list but is clean now: remove it`
			);
		}
	}
	expect(unexpected).toEqual([]);
});

test("every open list entry carries a reason", () => {
	for (const [file, entry] of Object.entries(OPEN_LIST)) {
		expect(`${file}: ${entry.reason.length > 20}`).toBe(`${file}: true`);
		expect(entry.count).toBeGreaterThan(0);
	}
	expect(
		[OVER_LIMIT, QUERY_SUFFIX, FIXED_WORD].every((reason) => reason.length > 20)
	).toBe(true);
});
