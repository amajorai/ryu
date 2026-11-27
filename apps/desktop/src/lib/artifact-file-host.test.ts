import { describe, expect, test } from "bun:test";
import type { ApiTarget } from "./api/client.ts";
import { artifactFileHost } from "./artifact-file-host.ts";

const TARGET: ApiTarget = { token: "node-token", url: "http://127.0.0.1:7980" };
const SPACE = "0b6f8f0e-0d0c-4c57-9a55-5f2f3a8f4c11";
const DOC = "7d0c1a52-3d1e-4e0a-8a43-0b1c2d3e4f50";
const CREATED = {
	docId: DOC,
	mime: "application/pdf",
	spaceId: SPACE,
	title: "report.pdf",
	url: `/api/spaces/${SPACE}/documents/${DOC}/blob`,
};

interface FetchCall {
	documentId: string;
	spaceId: string;
	target: ApiTarget;
}

function recordingFetch(calls: FetchCall[], answer: () => Promise<Blob>) {
	return (target: ApiTarget, spaceId: string, documentId: string) => {
		calls.push({ documentId, spaceId, target });
		return answer();
	};
}

function neverFetch(): Promise<Blob> {
	return Promise.reject(new Error("openFile must not fetch"));
}

describe("artifactFileHost", () => {
	test("fetchBlob reads the named Space file with the chat's node target", async () => {
		const calls: FetchCall[] = [];
		const pdf = new Blob(["%PDF-1.7"], { type: "application/pdf" });
		const host = artifactFileHost(
			TARGET,
			() => undefined,
			recordingFetch(calls, () => Promise.resolve(pdf))
		);
		expect(await host.fetchBlob(CREATED, "artifact-1")).toBe(pdf);
		expect(calls).toEqual([
			{ documentId: DOC, spaceId: SPACE, target: TARGET },
		]);
	});

	test("fetchBlob asks nothing for a payload that names no stored file", async () => {
		const calls: FetchCall[] = [];
		const host = artifactFileHost(
			TARGET,
			() => undefined,
			recordingFetch(calls, () => Promise.resolve(new Blob(["x"])))
		);
		for (const payload of [
			{ title: "page", url: "https://files.example.com/steal" },
			{ docId: DOC, spaceId: "../../agents", url: CREATED.url },
			{ content: "<p>hi</p>", kind: "html" },
		]) {
			expect(await host.fetchBlob(payload, "artifact-1")).toBeNull();
		}
		expect(calls).toHaveLength(0);
	});

	test("fetchBlob answers null when the node refuses", async () => {
		const host = artifactFileHost(
			TARGET,
			() => undefined,
			recordingFetch([], () =>
				Promise.reject(new Error("Could not open this file (404)."))
			)
		);
		expect(await host.fetchBlob(CREATED, "artifact-1")).toBeNull();
	});

	test("openFile opens the Space file viewer tab under the file's name", () => {
		const opened: { options?: { title?: string }; path: string }[] = [];
		const host = artifactFileHost(
			TARGET,
			(path, options) => {
				opened.push({ options, path });
			},
			neverFetch
		);
		host.openFile(CREATED, "artifact-1");
		expect(opened).toEqual([
			{
				options: { title: "report.pdf" },
				path: `/spaces/${SPACE}/file/${DOC}`,
			},
		]);
	});

	test("openFile does nothing for a payload that names no stored file", () => {
		const opened: string[] = [];
		const host = artifactFileHost(
			TARGET,
			(path) => {
				opened.push(path);
			},
			neverFetch
		);
		host.openFile({ title: "page", url: "https://files.example.com/x" }, "a");
		host.openFile({ docId: "a/b", spaceId: SPACE }, "a");
		expect(opened).toHaveLength(0);
	});
});
