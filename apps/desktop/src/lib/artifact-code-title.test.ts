import { describe, expect, test } from "bun:test";
import type { LiteralMessage } from "@ryu/i18n";
import { artifactDisplayTitle } from "./artifact-code-title.ts";
import { titleFor } from "./artifacts.ts";

const tl: LiteralMessage = (source, values) =>
	`[${source}]${values ? JSON.stringify(values) : ""}`;

describe("artifact code titles", () => {
	test("the stored title stays English", () => {
		expect(titleFor("code", "python", "x = 1")).toBe("Python snippet");
		expect(titleFor("code", "TypeScript", "const a = 1;")).toBe(
			"Typescript snippet"
		);
	});

	test("a generated snippet title renders as one translated message", () => {
		const title = titleFor("code", "python", "x = 1");
		expect(artifactDisplayTitle({ kind: "code", title }, tl)).toBe(
			'[{language} snippet]{"language":"Python"}'
		);
	});

	test("other titles are returned as written", () => {
		expect(artifactDisplayTitle({ kind: "code", title: "Code" }, tl)).toBe(
			"Code"
		);
		expect(
			artifactDisplayTitle({ kind: "html", title: "Rust snippet" }, tl)
		).toBe("Rust snippet");
	});

	test("the fixed svg and space titles are translated", () => {
		expect(
			artifactDisplayTitle({ kind: "svg", title: titleFor("svg", "", "") }, tl)
		).toBe("[Vector image]");
		expect(
			artifactDisplayTitle(
				{ kind: "space", title: titleFor("space", "", "") },
				tl
			)
		).toBe("[Space document]");
		expect(artifactDisplayTitle({ kind: "svg", title: "Logo" }, tl)).toBe(
			"Logo"
		);
	});
});
