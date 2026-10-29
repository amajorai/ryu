import { afterEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
	notifyManager,
	QueryClient,
	QueryObserver,
} from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { AppDisabledError } from "@/src/lib/api/client.ts";
import type { SpaceDocument } from "@/src/lib/api/spaces.ts";

if (globalThis.document === undefined) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
notifyManager.setScheduler(queueMicrotask);
const client = new QueryClient({
	defaultOptions: { queries: { retry: false } },
});
let node = { url: "http://node.test", token: "token", userJwt: "one" };
interface Read {
	reject: (error: Error) => void;
	resolve: <TValue>(value: TValue) => void;
	signal: AbortSignal;
}
const reads: Read[] = [];
const documentReads: (Read & { jwt: string; space: string })[] = [];
mock.module("@/src/lib/query-client.ts", () => ({ queryClient: client }));
mock.module("./useActiveNode.ts", () => ({ useActiveNode: () => node }));
mock.module("@/src/lib/core-refresh.ts", () => ({
	useCoreRefresh: () => undefined,
}));
mock.module("@/src/lib/gating/useEntityCap.ts", () => ({
	useEntityCap: () => ({ guard: () => true }),
}));
mock.module("@/src/lib/api/spaces.ts", () => ({
	fetchSpaces: (
		_target: Parameters<
			typeof import("@/src/lib/api/spaces.ts").fetchSpaces
		>[0],
		signal: AbortSignal
	) =>
		new Promise((resolve, reject) => reads.push({ signal, resolve, reject })),
	createSpace: async () => ({ retrievalMode: "vector" }),
	createDatabase: async () => "db",
	createPage: async () => "page",
	createWhiteboard: async () => "board",
	deleteSpace: async () => undefined,
	renameSpace: async () => undefined,
	deleteDocument: async () => true,
	fetchDocument: async () => ({}),
	fetchDocuments: (target: typeof node, space: string, signal: AbortSignal) =>
		new Promise((resolve, reject) =>
			documentReads.push({
				signal,
				resolve,
				reject,
				jwt: target.userJwt,
				space,
			})
		),
	ingestDocument: async () => undefined,
	searchSpace: async () => [],
	setDocumentIcon: async () => undefined,
	setSpaceIcon: async () => undefined,
	setSpaceVisibility: async () => undefined,
	setSpaceRetrievalMode: async () => ({ mode: "graph" }),
	updateDocument: async () => undefined,
	uploadSpaceFile: async () => ({ id: "file" }),
}));
const { useSpaces } = await import("./useSpaces.ts");
let root = createRoot(document.createElement("div"));
let first: ReturnType<typeof useSpaces>;
let second: ReturnType<typeof useSpaces>;
function Reader({ slot }: { slot: "first" | "second" }) {
	const result = useSpaces();
	if (slot === "first") {
		first = result;
	} else {
		second = result;
	}
	return null;
}
function Harness() {
	return (
		<>
			<Reader slot="first" />
			<Reader slot="second" />
		</>
	);
}
const settle = async (read: Read, name = "Research") =>
	act(async () => {
		read.resolve([{ id: "space", name, retrievalMode: "vector" }]);
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
afterEach(async () => {
	await act(async () => root.unmount());
	client.clear();
	root = createRoot(document.createElement("div"));
	reads.length = 0;
	documentReads.length = 0;
	node = { ...node, userJwt: "one" };
});
test("cached list mutations and revision signals reach every observer of the same scope", async () => {
	await act(async () => root.render(<Harness />));
	expect(reads).toHaveLength(1);
	await settle(reads[0]);
	await act(async () => {
		await first.rename("space", "Renamed");
		await first.saveDocument("space", "doc", "Title", "Source");
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
	expect(second.spaces[0].name).toBe("Renamed");
	expect(second.documentRevisions.get("space")).toBe(1);
	expect(reads).toHaveLength(1);
	node = { ...node, userJwt: "two" };
	await act(async () => root.render(<Harness />));
	expect(second.spaces).toEqual([]);
	expect(second.documentRevisions.size).toBe(0);
	await settle(reads[1], "Other user");
	await client.refetchQueries({ queryKey: ["space-document-revisions"] });
	node = { ...node, userJwt: "one" };
	await act(async () => root.render(<Harness />));
	expect(first.spaces[0].name).toBe("Renamed");
	expect(first.documentRevisions.get("space")).toBe(1);
	expect(reads).toHaveLength(2);
});
test("a mutation before first load cancels stale data and recovers the full list", async () => {
	await act(async () => root.render(<Harness />));
	let mutation = Promise.resolve();
	await act(async () => {
		mutation = first.rename("space", "New");
		await Promise.resolve();
	});
	expect(reads[0].signal.aborted).toBe(true);
	expect(reads).toHaveLength(2);
	await settle(reads[0], "Stale");
	await settle(reads[1], "New");
	await act(async () => {
		await mutation;
	});
	expect(second.spaces[0].name).toBe("New");
});
test("disabled-app errors retain their actionable state", async () => {
	await act(async () => root.render(<Harness />));
	await act(async () => {
		reads[0].reject(new AppDisabledError("@ryu/spaces", "Enable Spaces"));
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
	expect(first.appDisabled?.app).toBe("@ryu/spaces");
	expect(first.error).toBeNull();
	expect(first.loading).toBe(false);
});

test("concurrent document lists coalesce while explicit refresh still reads current data", async () => {
	await act(async () => root.render(<Harness />));
	const a = first.listDocuments("space");
	const b = second.listDocuments("space");
	expect(documentReads).toHaveLength(1);
	documentReads[0].resolve([{ id: "old" }]);
	expect(await a).toEqual(await b);
	const refreshed = first.listDocuments("space");
	expect(documentReads).toHaveLength(2);
	documentReads[1].resolve([{ id: "fresh" }]);
	expect((await refreshed).map((document) => document.id)).toEqual(["fresh"]);
});
test("a document mutation bypasses an unfinished old-revision list", async () => {
	await act(async () => root.render(<Harness />));
	const old = first.listDocuments("space");
	await act(async () => {
		await first.saveDocument("space", "doc", "New", "Text");
	});
	const current = second.listDocuments("space");
	expect(documentReads).toHaveLength(2);
	documentReads[1].resolve([{ id: "new" }]);
	expect((await current).map((document) => document.id)).toEqual(["new"]);
	documentReads[0].resolve([{ id: "old" }]);
	await old;
	const { spaceDocumentListQueryOptions } = await import(
		"@/src/lib/space-document-list-query.ts"
	);
	expect(
		client
			.getQueryData<SpaceDocument[]>(
				spaceDocumentListQueryOptions(node, "space", 1).queryKey
			)
			?.map((document) => document.id)
	).toEqual(["new"]);
});
test("document reads never coalesce across identities on the same node", async () => {
	await act(async () => root.render(<Harness />));
	const old = first.listDocuments("space");
	node = { ...node, userJwt: "two" };
	await act(async () => root.render(<Harness />));
	const current = first.listDocuments("space");
	expect(documentReads.map((read) => read.jwt)).toEqual(["one", "two"]);
	documentReads[0].resolve([{ id: "old" }]);
	documentReads[1].resolve([{ id: "new" }]);
	expect((await old).map((document) => document.id)).toEqual(["old"]);
	expect((await current).map((document) => document.id)).toEqual(["new"]);
});

test("unmounting a query observer does not abort another consumer's imperative read", async () => {
	await act(async () => root.render(<Harness />));
	const { spaceDocumentListQueryOptions } = await import(
		"@/src/lib/space-document-list-query.ts"
	);
	const observer = new QueryObserver(
		client,
		spaceDocumentListQueryOptions(node, "space", 0)
	);
	const unsubscribe = observer.subscribe(() => undefined);
	const pending = first.listDocuments("space");
	expect(documentReads).toHaveLength(1);
	unsubscribe();
	expect(documentReads[0].signal.aborted).toBe(false);
	documentReads[0].resolve([{ id: "kept" }]);
	expect((await pending).map((document) => document.id)).toEqual(["kept"]);
});
