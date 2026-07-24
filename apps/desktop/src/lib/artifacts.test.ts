// apps/desktop/src/lib/artifacts.test.ts
//
// Tests for the in-message "canvas artifact" extractor. The load-bearing
// behaviours are: which fenced blocks classify as which renderable kind
// (html/svg/mermaid/code), the LARGE_CODE gate that keeps one-liners out of the
// panel, the STABLE + NON-CONTIGUOUS id scheme (blockIndex advances for every
// fence, even skipped ones, so ids are deterministic across re-renders), and
// the user-message skip (a user pasting HTML is input, not an artifact).

import { describe, expect, it } from "bun:test";
import { type Artifact, extractArtifacts } from "./artifacts.ts";

// Build a loose stream message from an array of text-part strings.
const msg = (
	id: string | undefined,
	texts: string[],
	role?: string
): {
	id?: string;
	parts?: Array<{ type?: string; text?: unknown } | null>;
	role?: string;
} => ({
	id,
	role,
	parts: texts.map((text) => ({ type: "text", text })),
});

const fence = (lang: string, body: string) => `\`\`\`${lang}\n${body}\n\`\`\``;

describe("extractArtifacts — classification", () => {
	it("classifies a mermaid block and titles it by diagram keyword", () => {
		const [art] = extractArtifacts([
			msg("m1", [fence("mermaid", "sequenceDiagram\n  A->>B: hi")]),
		]);
		expect(art?.kind).toBe("mermaid");
		expect(art?.title).toBe("Sequence diagram");
	});

	it("recognises the mmd alias for mermaid", () => {
		const [art] = extractArtifacts([msg("m1", [fence("mmd", "graph TD")])]);
		expect(art?.kind).toBe("mermaid");
	});

	it("classifies an svg block and gives it the vector-image title", () => {
		const [art] = extractArtifacts([
			msg("m1", [fence("svg", "<svg><rect/></svg>")]),
		]);
		expect(art?.kind).toBe("svg");
		expect(art?.title).toBe("Vector image");
	});

	it("treats an xml block containing an <svg> as svg, but plain xml as nothing", () => {
		const svgXml = extractArtifacts([
			msg("m1", [fence("xml", "<svg><g/></svg>")]),
		]);
		expect(svgXml[0]?.kind).toBe("svg");
		const plainXml = extractArtifacts([
			msg("m2", [fence("xml", "<note>hi</note>")]),
		]);
		expect(plainXml).toHaveLength(0);
	});

	it("classifies an html block and pulls its <title>", () => {
		const [art] = extractArtifacts([
			msg("m1", [fence("html", "<title>My Page</title><body>x</body>")]),
		]);
		expect(art?.kind).toBe("html");
		expect(art?.title).toBe("My Page");
	});

	it("falls back to a heading, then to 'Web page', for an html title", () => {
		const heading = extractArtifacts([
			msg("m1", [fence("html", "# Landing\n<div>x</div>")]),
		]);
		expect(heading[0]?.title).toBe("Landing");
		const none = extractArtifacts([
			msg("m2", [fence("html", "<div>no title here</div>")]),
		]);
		expect(none[0]?.title).toBe("Web page");
	});

	it("detects an untagged block as html via a doctype/<html> lead", () => {
		const [art] = extractArtifacts([
			msg("m1", ["```\n<!doctype html><html></html>\n```"]),
		]);
		expect(art?.kind).toBe("html");
	});

	it("detects an untagged block as svg via a leading <svg>", () => {
		const [art] = extractArtifacts([
			msg("m1", ["```\n<svg viewBox='0 0 1 1'></svg>\n```"]),
		]);
		expect(art?.kind).toBe("svg");
	});
});

describe("extractArtifacts — the LARGE_CODE gate", () => {
	it("keeps a tiny code block out of the panel", () => {
		expect(
			extractArtifacts([msg("m1", [fence("python", "print('hi')")])])
		).toHaveLength(0);
	});

	it("promotes a code block that crosses the 16-line floor", () => {
		const body = Array.from({ length: 16 }, (_, i) => `line${i}`).join("\n");
		const [art] = extractArtifacts([msg("m1", [fence("python", body)])]);
		expect(art?.kind).toBe("code");
		expect(art?.title).toBe("Python snippet");
		expect(art?.language).toBe("python");
	});

	it("promotes a code block that crosses the 800-char floor even on one line", () => {
		const body = "x".repeat(800);
		const [art] = extractArtifacts([msg("m1", [fence("rust", body)])]);
		expect(art?.kind).toBe("code");
		expect(art?.language).toBe("rust");
	});

	it("never promotes a large NON_CODE_LANGS block (markdown/log/diff)", () => {
		const big = Array.from({ length: 40 }, (_, i) => `row ${i}`).join("\n");
		for (const lang of ["markdown", "md", "log", "diff", "patch", "text"]) {
			expect(
				extractArtifacts([msg("m1", [fence(lang, big)])])
			).toHaveLength(0);
		}
	});

	it("does NOT promote a large but language-less block (blank lang is non-code)", () => {
		// "" is a member of NON_CODE_LANGS, so even a 20-line untagged block that
		// isn't html/svg stays out of the panel — it reads as prose, not canvas.
		const body = Array.from({ length: 20 }, () => "a").join("\n");
		expect(extractArtifacts([msg("m1", [fence("", body)])])).toHaveLength(0);
	});
});

describe("extractArtifacts — ids, ordering, provenance", () => {
	it("derives a stable id from the message id and per-block index", () => {
		const [art] = extractArtifacts([
			msg("abc", [fence("mermaid", "graph TD")]),
		]);
		expect(art?.id).toBe("abc-artifact-0");
		expect(art?.sourceMessageId).toBe("abc");
	});

	it("advances blockIndex for skipped blocks, leaving ids non-contiguous", () => {
		// A skipped `text` block (index 0), then a real html block (index 1).
		const [art] = extractArtifacts([
			msg("m1", [`${fence("text", "just prose")}\n${fence("html", "<h1>Hi</h1>")}`]),
		]);
		expect(art?.id).toBe("m1-artifact-1");
	});

	it("falls back to a positional id when the message has no id", () => {
		const [art] = extractArtifacts([msg(undefined, [fence("svg", "<svg/>")])]);
		expect(art?.id).toBe("msg-0-artifact-0");
	});

	it("skips user messages but includes unlabelled (roleless) ones", () => {
		const arts = extractArtifacts([
			msg("u", [fence("html", "<h1>from user</h1>")], "user"),
			msg("a", [fence("html", "<h1>from assistant</h1>")], "assistant"),
			msg("n", [fence("svg", "<svg/>")]), // no role → included
		]);
		expect(arts.map((a: Artifact) => a.sourceMessageId)).toEqual(["a", "n"]);
	});

	it("preserves stream order across multiple messages", () => {
		const arts = extractArtifacts([
			msg("m1", [fence("svg", "<svg/>")]),
			msg("m2", [fence("mermaid", "pie")]),
		]);
		expect(arts.map((a: Artifact) => a.kind)).toEqual(["svg", "mermaid"]);
	});
});

describe("extractArtifacts — defensive shapes", () => {
	it("returns [] for messages with no fences at all (fast path)", () => {
		expect(extractArtifacts([msg("m1", ["plain text, no code"])])).toEqual([]);
	});

	it("ignores an empty-bodied fence", () => {
		expect(
			extractArtifacts([msg("m1", ["```html\n   \n```"])])
		).toHaveLength(0);
	});

	it("tolerates null messages, missing parts, and non-text parts", () => {
		const arts = extractArtifacts([
			null as never,
			{ id: "x" }, // no parts
			{ id: "y", parts: [null, { type: "image" }, { type: "text", text: 5 }] },
			msg("z", [fence("svg", "<svg/>")]),
		]);
		expect(arts).toHaveLength(1);
		expect(arts[0]?.sourceMessageId).toBe("z");
	});

	it("clamps an overlong html title to 48 chars with an ellipsis", () => {
		const long = "T".repeat(80);
		const [art] = extractArtifacts([
			msg("m1", [fence("html", `<title>${long}</title>`)]),
		]);
		expect(art?.title.length).toBe(48);
		expect(art?.title.endsWith("…")).toBe(true);
	});

	it("strips trailing whitespace from the captured content but keeps the body", () => {
		const [art] = extractArtifacts([
			msg("m1", [fence("svg", "<svg/>   ")]),
		]);
		expect(art?.content).toBe("<svg/>");
	});
});
