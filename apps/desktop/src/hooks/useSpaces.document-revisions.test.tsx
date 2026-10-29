import { afterAll, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { UseSpacesResult } from "./useSpaces.ts";

if (globalThis.document === undefined) {
	GlobalRegistrator.register();
}

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const apiCreateDatabase = mock(async () => "database-id");
const apiCreatePage = mock(async () => "page-id");
const apiDeleteDocument = mock(async () => true);
const apiIngestDocument = mock(async () => undefined);
const apiUpdateDocument = mock(async () => undefined);
const apiUploadSpaceFile = mock(async () => ({ id: "upload-id" }));
const fetchDocuments = mock(async () => []);
const fetchSpaces = mock(async () => []);

mock.module("@/src/lib/api/spaces.ts", () => ({
	createDatabase: apiCreateDatabase,
	createPage: apiCreatePage,
	createSpace: mock(async () => ({ retrievalMode: "hybrid" })),
	createWhiteboard: mock(async () => "whiteboard-id"),
	deleteDocument: apiDeleteDocument,
	deleteSpace: mock(async () => undefined),
	fetchDocument: mock(async () => ({ id: "document-id" })),
	fetchDocuments,
	fetchSpaces,
	ingestDocument: apiIngestDocument,
	renameSpace: mock(async () => undefined),
	searchSpace: mock(async () => []),
	setDocumentIcon: mock(async () => undefined),
	setSpaceIcon: mock(async () => undefined),
	setSpaceRetrievalMode: mock(async () => ({ mode: "hybrid" })),
	setSpaceVisibility: mock(async () => undefined),
	updateDocument: apiUpdateDocument,
	uploadSpaceFile: apiUploadSpaceFile,
}));
mock.module("@/src/lib/core-refresh.ts", () => ({
	useCoreRefresh: () => undefined,
}));
mock.module("@/src/lib/gating/useEntityCap.ts", () => ({
	useEntityCap: () => ({ guard: () => true }),
}));
mock.module("./useActiveNode.ts", () => ({
	useActiveNode: () => ({ token: "token", url: "https://node.example" }),
}));

const { useSpaces } = await import("./useSpaces.ts");

let currentResult: UseSpacesResult | null = null;

function SpacesHarness() {
	currentResult = useSpaces();
	return null;
}

function result(): UseSpacesResult {
	if (!currentResult) {
		throw new Error("Spaces hook did not render");
	}
	return currentResult;
}

const container = document.createElement("div");
document.body.append(container);
const root = createRoot(container);

afterAll(() => {
	act(() => root.unmount());
	container.remove();
});

describe("useSpaces document revisions", () => {
	test("bumps the per-Space signal after successful document mutations", async () => {
		await act(async () => {
			root.render(<SpacesHarness />);
			await Promise.resolve();
		});
		expect(result().documentRevisions.get("space-1") ?? 0).toBe(0);

		await act(async () => {
			await result().saveDocument("space-1", "page-1", "Page", "Updated");
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		expect(result().documentRevisions.get("space-1")).toBe(1);

		await act(async () => {
			await result().createPage("space-1", "Page");
			await result().createDatabase("space-1", "Database");
			await result().removeDocument("space-1", "page-1");
			await result().ingest("space-1", "Imported", "Content");
			await result().uploadFile(
				"space-1",
				new File(["content"], "document.txt", { type: "text/plain" })
			);
			await new Promise((resolve) => setTimeout(resolve, 0));
		});

		expect(result().documentRevisions.get("space-1")).toBe(6);
		expect(apiUpdateDocument).toHaveBeenCalledTimes(1);
		expect(apiCreatePage).toHaveBeenCalledTimes(1);
		expect(apiCreateDatabase).toHaveBeenCalledTimes(1);
		expect(apiDeleteDocument).toHaveBeenCalledTimes(1);
		expect(apiIngestDocument).toHaveBeenCalledTimes(1);
		expect(apiUploadSpaceFile).toHaveBeenCalledTimes(1);
	});
});
