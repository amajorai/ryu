import { describe, expect, it } from "bun:test";
import {
	artifactFromCreateResult,
	artifactFromInput,
	artifactIdForPart,
	isArtifactPart,
} from "./artifact-tool.ts";

describe("artifactFromInput", () => {
	it("reads the nested `artifact` object", () => {
		expect(
			artifactFromInput({
				artifact: { kind: "database", title: "Q3", content: "[]" },
			})
		).toEqual({ kind: "database", title: "Q3", content: "[]" });
	});

	it("accepts a flat payload", () => {
		expect(
			artifactFromInput({ kind: "code", title: "main.rs", content: "x" })
		).toEqual({ kind: "code", title: "main.rs", content: "x" });
	});

	it("returns null for empty or non-object input", () => {
		expect(artifactFromInput(null)).toBeNull();
		expect(artifactFromInput({})).toBeNull();
		expect(artifactFromInput("nope")).toBeNull();
	});
});

describe("artifactFromCreateResult", () => {
	it("merges the input title with the result's url/mime/doc identity", () => {
		const result = artifactFromCreateResult(
			{ title: "notes.csv", mime: "text/csv" },
			{
				ok: true,
				id: "doc-1",
				space_id: "sp-1",
				url: "/api/spaces/sp-1/documents/doc-1/blob",
				mime: "text/csv",
			}
		);
		expect(result).toEqual({
			title: "notes.csv",
			mime: "text/csv",
			url: "/api/spaces/sp-1/documents/doc-1/blob",
			spaceId: "sp-1",
			docId: "doc-1",
		});
	});

	it("keeps the byte size Core reports for the created file", () => {
		const created = {
			ok: true,
			id: "doc-2",
			space_id: "sp-1",
			url: "/api/spaces/sp-1/documents/doc-2/blob",
			mime: "application/pdf",
		};
		expect(
			artifactFromCreateResult(
				{ title: "report.pdf" },
				{ ...created, byte_size: 48_213 }
			)?.byteSize
		).toBe(48_213);
		// A size that is not a count of bytes is dropped, not shown.
		for (const byteSize of ["48213", -1, Number.NaN, null]) {
			expect(
				artifactFromCreateResult(
					{ title: "report.pdf" },
					{ ...created, byte_size: byteSize }
				)?.byteSize
			).toBeUndefined();
		}
	});

	it("returns null before the result carries a url, or on a failed create", () => {
		expect(artifactFromCreateResult({ title: "x" }, {})).toBeNull();
		expect(
			artifactFromCreateResult({ title: "x" }, { ok: false, available: false })
		).toBeNull();
	});
});

describe("isArtifactPart", () => {
	it("recognizes the typed render/create part types", () => {
		expect(isArtifactPart("tool-artifact.render", undefined)).toBe(true);
		expect(isArtifactPart("tool-artifact.create", undefined)).toBe(true);
	});

	it("recognizes dynamic-tool parts by their toolName", () => {
		expect(isArtifactPart("dynamic-tool", "artifact.render")).toBe(true);
		expect(isArtifactPart("dynamic-tool", "artifact.create")).toBe(true);
	});

	it("ignores unrelated parts", () => {
		expect(isArtifactPart("tool-Bash", undefined)).toBe(false);
		expect(isArtifactPart("dynamic-tool", "web_search")).toBe(false);
		expect(isArtifactPart("tool-ui.render", undefined)).toBe(false);
	});
});

describe("artifactIdForPart", () => {
	it("derives a stable id from the tool call id", () => {
		expect(artifactIdForPart("call_abc")).toBe("artifact-call_abc");
	});

	it("falls back to a fixed id when there is no tool call id", () => {
		expect(artifactIdForPart(undefined)).toBe("artifact-tool");
	});
});
