import { describe, expect, test } from "bun:test";
import type { LiteralMessage } from "@ryu/i18n/react";
import { sectionNote } from "./download-dropdown-content.tsx";

// A German stand-in for `tl` that formats the one message the note uses.
const german: LiteralMessage = (source, values = {}) =>
	source === "{version} is still building"
		? `${String((values as { version?: unknown }).version)} wird noch erstellt`
		: source;

describe("the Desktop App header note", () => {
	test("a release that is still building reads as a translated sentence", () => {
		expect(sectionNote({ kind: "building", version: "v0.42.0" }, german)).toBe(
			"v0.42.0 wird noch erstellt"
		);
	});

	test("a missing or unknown download adds no note", () => {
		expect(sectionNote({ kind: "unavailable" }, german)).toBe("");
		expect(
			sectionNote({ href: "https://example.com", kind: "unknown" }, german)
		).toBe("");
	});
});
