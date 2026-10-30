// packages/blocks/src/desktop/spaces-test-source.ts
//
// Shared source readers for the Spaces copy tests (`spaces.test.ts` and
// `spaces-index-copy.test.ts`).
//
// ── Why this reads the file instead of importing it ──────────────────────────
//
// The Spaces module imports `@ryu/ui/components/*` without file extensions. That subpath
// resolves under the desktop app's bundler and does NOT resolve under `bun test`,
// so importing it fails at module load —
// verified, not assumed. Reading the literal out of the sources is the honest
// alternative for an assertion about a *string*: {@link copyLiteral} THROWS when a
// constant is missing or re-spelled, so a renamed export reads as "go fix this
// test", never as a silently-passing scan of a file that no longer says anything.
//
// The Spaces block is split across `spaces.tsx` and its `spaces-*` siblings, so
// SOURCE is every one of those files concatenated: an assertion about the module's
// copy must not depend on which file a component happens to live in.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { requireTestValue } from "./test-required.ts";

const SOURCE_FILES = [
	"spaces.tsx",
	"spaces-visibility.tsx",
	"spaces-retrieval.tsx",
	"spaces-index-state.ts",
	"spaces-types.ts",
	"spaces-document-format.ts",
	"spaces-document-rows.tsx",
	"spaces-files-table.tsx",
	"spaces-home-shell.tsx",
	"spaces-detail.tsx",
] as const;

export const SOURCE_FILE =
	"packages/blocks/src/desktop/spaces.tsx (and its spaces-* siblings)";
export const SOURCE = SOURCE_FILES.map((file) =>
	readFileSync(join(import.meta.dir, file), "utf8")
).join("\n");

/**
 * Pull the value of an exported single-string constant out of the source.
 *
 * Throws rather than returning `""`: every assertion below is about what a
 * sentence says, and an empty string satisfies most `not.toMatch` checks. The
 * failure names the constant and the file so whoever renamed it knows where to go.
 */
export function copyLiteral(name: string): string {
	const match = new RegExp(
		`(?:export )?const ${name}\\s*(?::[^=]+)?=\\s*"((?:[^"\\\\]|\\\\.)*)"`
	).exec(SOURCE);
	if (!match) {
		throw new Error(
			`copy test lost its target: \`${name}\` is no longer a single-string ` +
				`const in ${SOURCE_FILE}. These tests assert what that sentence claims ` +
				"about Core's retrieval_mode scope; re-point them (and re-check the " +
				"new copy against apps/desktop/src/lib/api/spaces.test.ts, which pins " +
				"what Core actually reads the column for)."
		);
	}
	return requireTestValue(match[1], `copy literal ${name}`);
}

/**
 * Every blurb in `RETRIEVAL_MODE_OPTIONS`, keyed by mode. Throws if a mode is gone.
 *
 * `field` selects the technical blurb or the friendly-mode one. Both are asserted
 * against the same claims below, because the friendly copy is not a summary of the
 * technical copy — friendly mode ships default-ON, so it is the copy nearly every
 * user actually reads, and a consequence dropped from it is a consequence dropped
 * from the product for almost everybody.
 */
export function modeBlurb(
	value: "graph" | "vector",
	field: "blurb" | "friendlyBlurb" = "blurb"
): string {
	const options = SOURCE.slice(
		SOURCE.indexOf("export const RETRIEVAL_MODE_OPTIONS"),
		SOURCE.indexOf("export const RETRIEVAL_MODE_SCOPE")
	);
	// `blurb:` is matched with a preceding boundary so it cannot also match the
	// tail of `friendlyBlurb:` (and vice versa) once both fields are present.
	const match = new RegExp(
		`value: "${value}",[\\s\\S]*?(?:^|\\s)${field}:\\s*((?:\\s*"(?:[^"\\\\]|\\\\.)*")+)`,
		"m"
	).exec(options);
	if (!match) {
		throw new Error(
			`copy test lost its target: no \`${value}\` entry with a \`${field}\` in ` +
				`RETRIEVAL_MODE_OPTIONS (${SOURCE_FILE}).`
		);
	}
	// Blurbs are prettier-wrapped into adjacent string literals; rejoin them.
	return [
		...requireTestValue(match[1], "wrapped copy literal").matchAll(
			/"((?:[^"\\]|\\.)*)"/g
		),
	]
		.map((m) => requireTestValue(m[1], "copy string fragment"))
		.join("");
}

/**
 * The source with comments removed — what the user can actually be shown.
 *
 * The distinction is load-bearing here, not pedantry. The doc comments in
 * `spaces.tsx` deliberately QUOTE the retired overclaim, because a reader who does
 * not know what the old sentence promised cannot tell why the new one is worded so
 * carefully. Scanning raw source would make keeping that explanation impossible;
 * scanning the rendered half lets the file explain its own history while still
 * failing if the history comes back as shipping copy.
 */
export const RENDERED = SOURCE.replaceAll(/\/\*[\s\S]*?\*\//g, "").replaceAll(
	/^\s*\/\/.*$/gm,
	""
);

/** The value of one entry in the `FILE_INDEX_NOTES` record. Throws if it is gone. */
export function indexNote(state: string): string {
	const notes = SOURCE.slice(SOURCE.indexOf("export const FILE_INDEX_NOTES"));
	const match = new RegExp(
		`\\n\\t${state}:\\s*((?:\\s*"(?:[^"\\\\]|\\\\.)*")+)`
	).exec(notes);
	if (!match) {
		throw new Error(
			`copy test lost its target: no \`${state}\` entry in FILE_INDEX_NOTES ` +
				`(${SOURCE_FILE}). Core's IndexState has five wire states and each ` +
				"not-indexed one needs a sentence saying what the user can do about it."
		);
	}
	return [
		...requireTestValue(match[1], "wrapped copy literal").matchAll(
			/"((?:[^"\\]|\\.)*)"/g
		),
	]
		.map((m) => requireTestValue(m[1], "copy string fragment"))
		.join("");
}
