import { afterAll, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type {
	Space,
	SpaceDocument,
	SpaceDocumentContent,
} from "@/src/lib/api/spaces.ts";

if (globalThis.document === undefined) {
	GlobalRegistrator.register();
}
if (document.compatMode === "BackCompat") {
	document.open();
	document.write("<!doctype html><html><head></head><body></body></html>");
	document.close();
}

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const nativeMatchMedia = window.matchMedia.bind(window);
Reflect.set(window, "matchMedia", (query: string) => {
	const result = nativeMatchMedia(query);
	if (query.includes("prefers-reduced-motion")) {
		Reflect.set(result, "matches", true);
	}
	return result;
});

function deferred<Value>() {
	let resolve = (_value: Value) => undefined;
	let reject = (_reason?: Parameters<typeof Promise.reject>[0]) => undefined;
	const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
		resolve = (value) => {
			resolvePromise(value);
		};
		reject = (reason) => {
			rejectPromise(reason);
		};
	});
	return { promise, reject, resolve };
}

function documentFixture(id: string, updatedAt: number): SpaceDocument {
	return {
		byteSize: null,
		chunkCount: 1,
		createdAt: 1,
		icon: null,
		id,
		indexMessage: null,
		indexState: null,
		indexWarnings: [],
		kind: "database",
		mime: null,
		rawKind: "database",
		spaceId: "space-1",
		title: id === "first" ? "First" : "Second",
		updatedAt,
	};
}

function contentFixture(id: string, source: string): SpaceDocumentContent {
	return {
		chunkCount: 1,
		createdAt: 1,
		icon: null,
		id,
		kind: "database",
		source,
		spaceId: "space-1",
		title: id === "first" ? "First" : "Second",
		updatedAt: 2,
	};
}

const firstPreview = deferred<SpaceDocumentContent>();
const secondPreview = deferred<SpaceDocumentContent>();
let revision = 0;
let listMode: "documents" | "empty" | "error" = "documents";
const listDocuments = mock(async () => {
	if (listMode === "error") {
		throw new Error("offline");
	}
	if (listMode === "empty") {
		return [];
	}
	return [
		documentFixture("first", revision + 1),
		documentFixture("second", revision + 1),
	];
});
const getDocument = mock((_spaceId: string, documentId: string) => {
	if (revision === 0) {
		return documentId === "first"
			? firstPreview.promise
			: secondPreview.promise;
	}
	return Promise.resolve(
		contentFixture(documentId, '{"columns":[{}],"rows":[{}]}')
	);
});
const createPage = mock(async () => "created-page");
const createDatabase = mock(async () => "created-database");
const openTab = mock();

mock.module("@ryu/ui/components/editor/editor-kit.tsx", () => ({
	EditorKit: [{ key: "markdown" }],
}));
mock.module("@/src/contexts/SpacesContext.tsx", () => ({
	useSpacesContext: () => ({
		createDatabase,
		createPage,
		documentRevisions: new Map([["space-1", revision]]),
		getDocument,
		listDocuments,
	}),
}));
mock.module("@/src/contexts/TabsContext.tsx", () => ({
	useTabSelector: <TResult,>(
		selector: (state: { openTab: typeof openTab }) => TResult
	) => selector({ openTab }),
}));

// This interaction suite exercises an already visible folder. Real observer and
// scroll behavior is covered by the production Spaces browser test.
const motion = await import("motion/react");
mock.module("motion/react", () => ({ ...motion, useInView: () => true }));
const { SpaceProjectFolder } = await import("./SpaceProjectFolder.tsx");

const space: Space = {
	createdAt: 1,
	description: "Project documents",
	documentCount: 2,
	icon: null,
	id: "space-1",
	name: "Research",
	retrievalMode: "vector",
	system: false,
	updatedAt: 1,
};

const container = document.createElement("div");
document.body.append(container);
const root = createRoot(container);

async function waitForCondition(condition: () => boolean): Promise<boolean> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (condition()) {
			return true;
		}
		await act(async () => {
			await new Promise<void>((resolve) => window.setTimeout(resolve, 5));
		});
	}
	return condition();
}

async function renderFolder(): Promise<void> {
	await act(async () => {
		root.render(
			<SpaceProjectFolder
				favorited={false}
				onToggleFavorite={() => undefined}
				space={space}
			/>
		);
		await Promise.resolve();
	});
}

function requiredButton(selector: string): HTMLButtonElement {
	const button = document.querySelector<HTMLButtonElement>(selector);
	if (!button) {
		throw new Error(`Missing Space folder button: ${selector}`);
	}
	return button;
}

afterAll(() => {
	act(() => root.unmount());
	container.remove();
	document.body.replaceChildren();
});

describe("SpaceProjectFolder interactions", () => {
	test("resolves previews independently, invalidates on revision, and distinguishes list errors", async () => {
		await renderFolder();
		expect(
			await waitForCondition(
				() => container.textContent?.includes("2 documents") === true
			)
		).toBeTrue();

		act(() => requiredButton('button[aria-haspopup="dialog"]').click());
		expect(
			await waitForCondition(
				() =>
					document.querySelectorAll('[aria-label^="Loading preview for"]')
						.length === 2
			)
		).toBeTrue();

		await act(async () => {
			firstPreview.resolve(
				contentFixture("first", '{"columns":[{}],"rows":[{}]}')
			);
			await Promise.resolve();
		});
		expect(document.body.textContent?.includes("1 column · 1 row")).toBeTrue();
		expect(
			document.querySelector('[aria-label="Loading preview for Second"]')
		).not.toBeNull();

		await act(async () => {
			secondPreview.reject(new Error("preview failed"));
			await Promise.resolve();
		});
		expect(
			document.body.textContent?.includes("Preview unavailable")
		).toBeTrue();

		act(() => requiredButton('button[aria-label="Open First"]').click());
		expect(
			await waitForCondition(
				() => document.querySelector('[role="dialog"]') === null
			)
		).toBeTrue();
		expect(openTab).toHaveBeenCalledWith("/spaces/space-1/db/first", {
			title: "First",
		});

		revision = 1;
		await renderFolder();
		expect(
			await waitForCondition(() => getDocument.mock.calls.length === 4)
		).toBeTrue();

		listMode = "error";
		revision = 2;
		await renderFolder();
		expect(
			await waitForCondition(
				() => container.textContent?.includes("0 documents") === true
			)
		).toBeTrue();
		act(() => requiredButton('button[aria-haspopup="dialog"]').click());
		expect(
			await waitForCondition(
				() =>
					document.body.textContent?.includes("Couldn’t load documents") ===
					true
			)
		).toBeTrue();
		expect(document.body.textContent?.includes("No documents yet")).toBeFalse();

		listMode = "empty";
		act(() => {
			for (const button of document.querySelectorAll<HTMLButtonElement>(
				"button"
			)) {
				if (button.textContent?.includes("Try again")) {
					button.click();
					return;
				}
			}
			throw new Error("Missing retry button");
		});
		expect(
			await waitForCondition(
				() => document.body.textContent?.includes("No documents yet") === true
			)
		).toBeTrue();
		act(() => {
			for (const button of document.querySelectorAll<HTMLButtonElement>(
				"button"
			)) {
				if (button.textContent?.includes("Create page")) {
					button.click();
					return;
				}
			}
			throw new Error("Missing create page button");
		});
		expect(
			await waitForCondition(
				() => document.querySelector('[role="dialog"]') === null
			)
		).toBeTrue();
		expect(createPage).toHaveBeenCalledWith("space-1", "Untitled");
		expect(openTab).toHaveBeenCalledWith("/spaces/space-1/doc/created-page", {
			title: "Untitled",
		});
	});
});
