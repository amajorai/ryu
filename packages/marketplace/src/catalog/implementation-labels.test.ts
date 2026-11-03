// Every word a listing builder emits for the "Extends" and "Where it lives"
// lists must reach a translated message. The builders are read from source, so
// a new or renamed word in the server, Core or the client fallback fails here
// instead of shipping in English.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { LiteralMessage } from "@ryu/i18n/react";
import {
	implementationFeatureLabel,
	implementationFeatureLine,
	implementationGroupLabel,
} from "./implementation-labels.ts";

const REPO = join(import.meta.dir, "../../../..");

/** The source between two markers of a repository file. */
function slice(path: string, start: string, end: string | null): string {
	const source = readFileSync(join(REPO, path), "utf8");
	const from = source.indexOf(start);
	const to = end === null ? source.length : source.indexOf(end, from);
	if (from < 0 || to <= from) {
		throw new Error(`builder markers moved in ${path}`);
	}
	// Comments mention words ("Extends" list) that no builder emits.
	return source
		.slice(from, to)
		.split("\n")
		.filter((line) => !/^\s*(?:\/\/|\/\*|\*)/u.test(line))
		.join("\n");
}

const BUILDERS = [
	slice(
		"packages/api/src/routers/marketplace.ts",
		"function manifestExtensions(",
		"/** True when a listing ships a Companion"
	),
	slice(
		"apps/core/src/catalog_source/manifest_surface.rs",
		"fn capability_extension_target(",
		"fn runnable_entry("
	),
	slice(
		"packages/marketplace/src/catalog/surface-summary.ts",
		"function capabilityTarget(",
		null
	),
];

/** Group headings the builders emit (capitalized display words). */
const GROUPS = new Set([
	"Browser",
	"Computer",
	"Web",
	"Document pipeline",
	"Core capability",
	"Shared Ryu shell",
	"Core runtime",
	"Package sidecar",
]);

/** Quoted display words: anything with a space or a capital, plus `themes`.
 * Bare lowercase ids (`core`, `dock_panels`, `browser.`), camelCase fields and
 * `format!` templates (checked separately below) are not copy. */
function builderWords(): Set<string> {
	const words = new Set<string>();
	for (const source of BUILDERS) {
		for (const match of source.matchAll(/"([^"\\\n]+)"/gu)) {
			const word = match[1] ?? "";
			if (/^[a-z]+[A-Z]|\{/u.test(word)) {
				continue;
			}
			if (/\s|[A-Z]/u.test(word) || word === "themes") {
				words.add(word);
			}
		}
	}
	return words;
}

/** A stand-in translator that marks every message it formats. */
const marked: LiteralMessage = (source, values) => {
	const fills = (values ?? {}) as Record<string, unknown>;
	return `«${source.replace(/\{(\w+)\}/gu, (_, key: string) => String(fills[key]))}»`;
};

describe("implementation labels cover every builder word", () => {
	const words = builderWords();

	test("the source scan finds the builder vocabulary", () => {
		for (const word of [
			"host-rendered views",
			"capability broker",
			"Shared Ryu shell",
			"MCP registration",
			"wallpaper backgrounds",
		]) {
			expect(words.has(word)).toBe(true);
		}
	});

	test("each group heading and feature word is a translated message", () => {
		const untranslated: string[] = [];
		for (const word of words) {
			const label = GROUPS.has(word)
				? implementationGroupLabel(marked, word)
				: implementationFeatureLabel(marked, word);
			if (!label.startsWith("«")) {
				untranslated.push(word);
			}
		}
		expect(untranslated).toEqual([]);
	});

	test("the templated runnable and process words translate whole", () => {
		for (const source of BUILDERS) {
			expect(/\{[\w.]*kind\} runnable/u.test(source)).toBe(true);
			expect(/\{[\w.]*\} process/u.test(source)).toBe(true);
		}
		expect(implementationFeatureLabel(marked, "tool runnable")).toBe(
			"«tool runnable»"
		);
		expect(implementationFeatureLabel(marked, "Agent runnable")).toBe(
			"«agent runnable»"
		);
		// Every RunnableKind has its own whole message, so no kind word stays
		// English inside the "{kind} runnable" fallback template.
		const kinds = [
			...readFileSync(
				join(REPO, "crates/core/kernel-contracts/src/runnable.rs"),
				"utf8"
			).matchAll(/RunnableKind::\w+ => "(\w+)"/gu),
		].map((match) => match[1] ?? "");
		expect(kinds.length).toBeGreaterThanOrEqual(8);
		const sources: string[] = [];
		const recording: LiteralMessage = (source, values) => {
			sources.push(source);
			return marked(source, values);
		};
		for (const kind of kinds) {
			implementationFeatureLabel(recording, `${kind} runnable`);
		}
		expect(sources).toEqual(kinds.map((kind) => `${kind} runnable`));
		expect(implementationFeatureLabel(marked, "gizmo runnable")).toBe(
			"«gizmo runnable»"
		);
		expect(implementationFeatureLabel(marked, "indexer process")).toBe(
			"«indexer process»"
		);
		expect(implementationFeatureLabel(marked, "managed process")).toBe(
			"«managed process»"
		);
	});
});

describe("unknown words pass through", () => {
	test("capability ids and provider titles keep their text", () => {
		expect(implementationFeatureLabel(marked, "browser.control")).toBe(
			"browser.control"
		);
		expect(
			implementationFeatureLabel(marked, "Page reader (browser.read)")
		).toBe("Page reader (browser.read)");
		expect(implementationGroupLabel(marked, "Publisher group")).toBe(
			"Publisher group"
		);
	});

	test("the feature line translates each word before joining", () => {
		expect(
			implementationFeatureLine(marked, [
				"host-rendered views",
				"browser.control",
			])
		).toBe("«host-rendered views» · browser.control");
	});
});
