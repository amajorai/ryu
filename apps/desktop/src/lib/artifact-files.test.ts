import { describe, expect, test } from "bun:test";
import {
	artifactByteSize,
	artifactContentBlob,
	artifactDownloadName,
	artifactText,
	isFileCardArtifact,
	spaceFileRef,
} from "./artifact-files.ts";

const SPACE = "0b6f8f0e-0d0c-4c57-9a55-5f2f3a8f4c11";
const DOC = "7d0c1a52-3d1e-4e0a-8a43-0b1c2d3e4f50";
const BLOB_URL = `/api/spaces/${SPACE}/documents/${DOC}/blob`;

describe("artifactText and artifactByteSize", () => {
	test("read only the shapes they name", () => {
		expect(artifactText("report.pdf")).toBe("report.pdf");
		for (const value of ["", 7, null, undefined, { title: "x" }]) {
			expect(artifactText(value)).toBeUndefined();
		}
		expect(artifactByteSize(0)).toBe(0);
		expect(artifactByteSize(48_213)).toBe(48_213);
		for (const value of [-1, Number.NaN, "48213", null, undefined]) {
			expect(artifactByteSize(value)).toBeUndefined();
		}
	});
});

describe("spaceFileRef", () => {
	test("takes the ids of the tool result", () => {
		expect(spaceFileRef({ docId: DOC, spaceId: SPACE, url: BLOB_URL })).toEqual(
			{ docId: DOC, spaceId: SPACE }
		);
	});

	test("reads the ids from the blob route when the result has none", () => {
		expect(spaceFileRef({ url: BLOB_URL })).toEqual({
			docId: DOC,
			spaceId: SPACE,
		});
	});

	test("ignores every URL that is not exactly the blob route", () => {
		for (const url of [
			`https://files.example.com${BLOB_URL}`,
			`//files.example.com${BLOB_URL}`,
			`${BLOB_URL}?next=https://files.example.com`,
			`${BLOB_URL}/../../../settings`,
			`/api/spaces/${SPACE}/documents/../../agents/blob`,
			`/api/spaces/${SPACE}/documents/${DOC}`,
			"/api/agents",
			"javascript:alert(1)",
			"",
		]) {
			expect(spaceFileRef({ url })).toBeNull();
		}
	});

	test("refuses ids that do not look like ids, without falling back", () => {
		for (const spaceId of [
			"../../agents",
			"a/b",
			"a b",
			"a?b",
			"a#b",
			"a%2Fb",
		]) {
			expect(spaceFileRef({ docId: DOC, spaceId, url: BLOB_URL })).toBeNull();
			expect(
				spaceFileRef({ docId: spaceId, spaceId: SPACE, url: BLOB_URL })
			).toBeNull();
		}
		expect(spaceFileRef({ spaceId: SPACE, url: BLOB_URL })).toBeNull();
		expect(spaceFileRef({ docId: "x".repeat(129), spaceId: SPACE })).toBeNull();
	});

	test("an artifact with no stored file has none", () => {
		expect(spaceFileRef(null)).toBeNull();
		expect(spaceFileRef({})).toBeNull();
		expect(spaceFileRef({ content: "<p>hi</p>", kind: "html" })).toBeNull();
	});
});

describe("isFileCardArtifact", () => {
	test("a created PDF, image, office file or archive is a file card", () => {
		for (const mime of [
			"application/pdf",
			"image/png",
			"image/jpeg",
			"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
			"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
			"application/zip",
			"application/octet-stream",
		]) {
			expect(isFileCardArtifact({ mime, title: "f", url: BLOB_URL })).toBe(
				true
			);
		}
		// No type at all: still a stored file the chat cannot read as text.
		expect(isFileCardArtifact({ title: "f", url: BLOB_URL })).toBe(true);
	});

	test("a created text artifact keeps the artifact card", () => {
		for (const mime of [
			"text/html",
			"image/svg+xml",
			"text/csv",
			"application/json",
			"text/markdown",
			"text/plain",
			"text/x-python",
		]) {
			expect(isFileCardArtifact({ mime, title: "f", url: BLOB_URL })).toBe(
				false
			);
		}
	});

	test("an artifact with inline content or a declared kind is not a file card", () => {
		expect(
			isFileCardArtifact({ content: "<p>hi</p>", kind: "html", title: "Page" })
		).toBe(false);
		expect(
			isFileCardArtifact({
				content: "%PDF",
				mime: "application/pdf",
				url: BLOB_URL,
			})
		).toBe(false);
		expect(
			isFileCardArtifact({
				kind: "html",
				mime: "application/pdf",
				url: BLOB_URL,
			})
		).toBe(false);
		expect(isFileCardArtifact({ mime: "application/pdf" })).toBe(false);
		expect(isFileCardArtifact(null)).toBe(false);
	});
});

describe("artifactDownloadName", () => {
	const base = { content: "x", kind: "html", title: "Q3 chart" } as const;

	test("adds the ending of the kind", () => {
		expect(artifactDownloadName(base)).toBe("Q3 chart.html");
		expect(artifactDownloadName({ ...base, kind: "svg" })).toBe("Q3 chart.svg");
		expect(artifactDownloadName({ ...base, kind: "mermaid" })).toBe(
			"Q3 chart.mmd"
		);
		expect(artifactDownloadName({ ...base, kind: "space" })).toBe(
			"Q3 chart.md"
		);
		expect(artifactDownloadName({ ...base, kind: "file" })).toBe("Q3 chart");
	});

	test("code takes the ending of its language, else txt", () => {
		expect(
			artifactDownloadName({ ...base, kind: "code", language: "Python" })
		).toBe("Q3 chart.py");
		expect(
			artifactDownloadName({ ...base, kind: "code", language: "brainfuzz" })
		).toBe("Q3 chart.txt");
		expect(
			artifactDownloadName({ ...base, kind: "code", language: "constructor" })
		).toBe("Q3 chart.txt");
		expect(artifactDownloadName({ ...base, kind: "code" })).toBe(
			"Q3 chart.txt"
		);
	});

	test("a table is saved as JSON or CSV by what it holds", () => {
		expect(
			artifactDownloadName({ ...base, content: "a,b\n1,2", kind: "database" })
		).toBe("Q3 chart.csv");
		expect(
			artifactDownloadName({
				...base,
				content: ' [{"a":1}]',
				kind: "database",
			})
		).toBe("Q3 chart.json");
		expect(
			artifactDownloadName({
				...base,
				content: "a,b",
				kind: "database",
				mime: "application/json",
			})
		).toBe("Q3 chart.json");
	});

	test("keeps a title that already carries a text file ending", () => {
		expect(
			artifactDownloadName({ ...base, kind: "code", title: "main.rs" })
		).toBe("main.rs");
		expect(artifactDownloadName({ ...base, title: "index.html" })).toBe(
			"index.html"
		);
		// A dot that is not a file ending does not count.
		expect(artifactDownloadName({ ...base, title: "Plan v1.2" })).toBe(
			"Plan v1.2.html"
		);
	});

	test("an empty title still gets a name", () => {
		expect(artifactDownloadName({ ...base, title: "  " })).toBe(
			"artifact.html"
		);
	});
});

describe("artifactContentBlob", () => {
	test("is always plain text, whatever the content", async () => {
		const blob = artifactContentBlob("<script>alert(1)</script>");
		expect(blob.type.startsWith("text/plain")).toBe(true);
		expect(await blob.text()).toBe("<script>alert(1)</script>");
	});
});
