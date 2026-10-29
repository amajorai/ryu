import { expect, test } from "bun:test";
import { artifactFromSdkObservation } from "./live-artifacts.ts";

test("a declared kind is matched case-insensitively", () => {
	const view = artifactFromSdkObservation(
		{ kind: "HTML", mime: "image/svg+xml", content: "<h1>Hi</h1>" },
		"a1",
		"msg-1"
	);
	expect(view.kind).toBe("html");
	expect(view.id).toBe("a1");
	expect(view.sourceMessageId).toBe("msg-1");
	expect(artifactFromSdkObservation({ kind: "Mermaid" }, "a2").kind).toBe(
		"mermaid"
	);
});

test("an unknown or missing kind falls back to the mime type", () => {
	expect(
		artifactFromSdkObservation({ kind: "slides", mime: "image/svg+xml" }, "a")
			.kind
	).toBe("svg");
	expect(
		artifactFromSdkObservation({ mime: "text/csv", content: "a,b" }, "a").kind
	).toBe("database");
	expect(artifactFromSdkObservation({ kind: 42 }, "a").kind).toBe("file");
	const empty = artifactFromSdkObservation(null, "a");
	expect(empty.kind).toBe("file");
	expect(empty.sourceMessageId).toBe("tool");
	expect(empty.title).toBe("File");
});

test("a non-blank declared title is clamped; a blank one derives from the content", () => {
	const long = `  ${"Quarterly revenue dashboard ".repeat(4)}  `;
	const clamped = artifactFromSdkObservation(
		{ kind: "html", title: long, content: "<title>Ignored</title>" },
		"a"
	).title;
	expect(clamped.length).toBe(48);
	expect(clamped.endsWith("…")).toBe(true);
	expect(clamped.startsWith("Quarterly revenue dashboard")).toBe(true);

	expect(
		artifactFromSdkObservation(
			{ kind: "html", title: "   ", content: "<title>Status page</title>" },
			"a"
		).title
	).toBe("Status page");
	expect(
		artifactFromSdkObservation(
			{ kind: "code", language: "rust", content: "fn main() {}" },
			"a"
		).title
	).toBe("Rust snippet");
});

test("a content-derived title that comes out empty falls back to 'Artifact'", () => {
	expect(
		artifactFromSdkObservation(
			{ kind: "html", content: "<title>   </title>" },
			"a"
		).title
	).toBe("Artifact");
});

test("non-string content becomes an empty string", () => {
	const view = artifactFromSdkObservation(
		{ kind: "code", content: { nested: true } },
		"a"
	);
	expect(view.content).toBe("");
	expect(view.title).toBe("Code");
});

test("opaque fields keep their original references", () => {
	const filePath = { path: "/tmp/report.html" };
	const url = { href: "https://example.test/a" };
	const spaceId = ["space-1"];
	const docId = { id: "doc-1" };
	const actions = [{ id: "open" }];
	const mime = "text/html";
	const language = "html";
	const view = artifactFromSdkObservation(
		{ filePath, url, spaceId, docId, actions, mime, language, content: "x" },
		"a"
	);
	expect(view.filePath).toBe(filePath);
	expect(view.url).toBe(url);
	expect(view.spaceId).toBe(spaceId);
	expect(view.docId).toBe(docId);
	expect(view.actions).toBe(actions);
	expect(view.mime).toBe(mime);
	expect(view.language).toBe(language);
});
