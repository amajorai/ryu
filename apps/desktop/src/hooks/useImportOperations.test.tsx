// apps/desktop/src/hooks/useImportOperations.test.tsx
//
// The hook an import surface uses, against a stand-in node over real HTTP:
// the start request, the reads of the surface's own operations, stop, retry,
// clear, the answer of an older node, an import found after a reload, and the
// rule that a surface takes only the signed-in user's own import, and only from
// the active node. While the client sends an identity it cannot name (a
// placeholder account, an unverified bearer), the surface takes nothing.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import type { Root } from "react-dom/client";

const NativeResponse = globalThis.Response;
const nativeFetch = globalThis.fetch;
const nativeAbortController = globalThis.AbortController;
const nativeAbortSignal = globalThis.AbortSignal;
const nativeReadableStream = globalThis.ReadableStream;
if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
// Happy DOM replaces these globals and Bun's native fetch refuses its
// AbortSignal. Keep the runtime's own, as the downloads stream suite does.
Reflect.set(globalThis, "AbortController", nativeAbortController);
Reflect.set(globalThis, "AbortSignal", nativeAbortSignal);
Reflect.set(globalThis, "ReadableStream", nativeReadableStream);
const { createRoot } = await import("react-dom/client");
const { parseOperation } = await import("@/src/lib/api/operations.ts");
const { useOperationsStore } = await import(
	"@/src/store/useOperationsStore.ts"
);
const { useWorkspaceStore } = await import("@/src/store/useWorkspaceStore.ts");
const { useNodeStore } = await import("@/src/store/useNodeStore.ts");
const { registerVaultOwnerSource } = await import("@/lib/session-owner.ts");
const { registerImportedFolders, useImportOperations } = await import(
	"./useImportOperations.ts"
);
const initialNodes = useNodeStore.getState();

import type { ApiTarget } from "@/src/lib/api/client.ts";
import type { ImportOutcome } from "@/src/lib/api/import.ts";
import type { ImportOperationsView } from "./useImportOperations.ts";

const SURFACE = "test-surface";
const RUN = "/api/import/run";
const READ = "/api/operations/op_1";
const KEY = /^import-/;
const LONG = 15_000;

interface Seen {
	body: unknown;
	method: string;
	path: string;
}

let root: Root;
let container: HTMLDivElement;
let server: ReturnType<typeof Bun.serve>;
let target: ApiTarget;
let seen: Seen[];
let unexpected: string[];
let folders: string[];
/** What the stand-in node answers, by "METHOD path". `null` is a 404. */
let answers: Record<string, unknown>;
let view: ImportOperationsView;
let originalAddProjectFolder: (path: string) => void;
let unregisterOwner: () => void;

/** The signed-in user of these tests. */
const ME = "user-a";
/** Where the auth client reads the session bearer from when it has no vault. */
const SESSION_BEARER_KEY = "ryu_session_token";

/** One operation as the node serializes it. */
function wire(over: Record<string, unknown> = {}) {
	return {
		attempt: 1,
		cancelRequested: false,
		createdAt: "2026-11-18T10:00:00.000Z",
		id: "op_1",
		kind: "import.setup",
		progress: { done: 0, total: 2 },
		resumable: true,
		resumed: false,
		status: "running",
		title: ".claude",
		updatedAt: "2026-11-18T10:00:00.000Z",
		...over,
	};
}

function at(seconds: number): string {
	return new Date(Date.UTC(2026, 10, 18, 10, 0, seconds)).toISOString();
}

function outcomeWire(id: string, status: string, folderPath?: string) {
	return {
		folder_path: folderPath,
		id,
		kind: folderPath ? "instructions" : "skill",
		status,
		title: id,
	};
}

const BOTH = [
	outcomeWire("skills/a", "imported"),
	outcomeWire("CLAUDE.md", "imported", "/home/demo/project"),
];

function requests(method: string, path: string): Seen[] {
	return seen.filter((r) => r.method === method && r.path === path);
}

function Probe() {
	view = useImportOperations(target, SURFACE);
	return null;
}

async function until(predicate: () => boolean, what: string) {
	const end = Date.now() + 6000;
	while (!predicate()) {
		if (Date.now() > end) {
			throw new Error(
				`Timed out waiting for ${what}: ${JSON.stringify({
					operations: view?.operations,
					seen,
				})}`
			);
		}
		await act(async () => {
			await Bun.sleep(10);
		});
	}
}

async function mount() {
	await act(async () => root.render(<Probe />));
}

async function start(): Promise<ImportOutcome[]> {
	let plain: ImportOutcome[] = [];
	await act(async () => {
		plain = await view.start([
			{
				items: [
					{ id: "skills/a", kind: "skill" },
					{ id: "CLAUDE.md", kind: "instructions" },
				],
				path: "/home/demo/.claude",
			},
		]);
	});
	return plain;
}

beforeEach(() => {
	seen = [];
	unexpected = [];
	folders = [];
	answers = {};
	// Only the stand-in node is reachable. A request to any other address (the
	// control plane's token exchange, for one) is refused here and fails the test.
	globalThis.fetch = Object.assign(
		(...args: Parameters<typeof nativeFetch>) => {
			const [input] = args;
			let url: string;
			if (typeof input === "string") {
				url = input;
			} else {
				url = "url" in input ? input.url : input.href;
			}
			if (!url.startsWith(target.url)) {
				unexpected.push(`outside the node: ${url}`);
				return Promise.resolve(new NativeResponse("refused", { status: 503 }));
			}
			return nativeFetch(...args);
		},
		{ preconnect: nativeFetch.preconnect.bind(nativeFetch) }
	);
	server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const path = new URL(request.url).pathname;
			const body: unknown =
				request.method === "POST"
					? await request.json().catch(() => null)
					: null;
			seen.push({ body, method: request.method, path });
			const key = `${request.method} ${path}`;
			if (!Object.hasOwn(answers, key)) {
				unexpected.push(key);
				return new NativeResponse("Unknown route", { status: 503 });
			}
			const answer = answers[key];
			if (answer === null) {
				return NativeResponse.json({ error: "not found" }, { status: 404 });
			}
			return NativeResponse.json(answer);
		},
	});
	target = {
		token: "node-a",
		url: server.url.toString().replace(/\/$/, ""),
		userJwt: "user-a",
	};
	// The dialog talks to the active node, as it does in the app.
	useNodeStore.setState({
		autoSelect: false,
		autoSelectedNode: null,
		defaultNode: "test-node",
		nodes: [{ name: "test-node", ...target }],
		tabOverrides: {},
	});
	unregisterOwner = registerVaultOwnerSource({
		accountCount: () => 1,
		verifiedActiveUserId: () => ME,
	});
	useOperationsStore.getState().reset();
	originalAddProjectFolder = useWorkspaceStore.getState().addProjectFolder;
	useWorkspaceStore.setState({
		addProjectFolder: (path: string) => {
			folders.push(path);
		},
	});
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});

afterEach(async () => {
	await act(async () => root.unmount());
	server.stop(true);
	container.remove();
	globalThis.fetch = nativeFetch;
	useOperationsStore.getState().reset();
	useWorkspaceStore.setState({ addProjectFolder: originalAddProjectFolder });
	useNodeStore.setState(initialNodes, true);
	unregisterOwner();
	localStorage.removeItem(SESSION_BEARER_KEY);
	if (unexpected.length > 0) {
		throw new Error(`Unexpected requests: ${JSON.stringify(unexpected)}`);
	}
});

test("imported folders are registered once each", () => {
	const outcome = (id: string, folderPath?: string): ImportOutcome => ({
		alreadyExists: false,
		folderPath,
		id,
		kind: "instructions",
		status: "imported",
		title: id,
	});
	expect(
		registerImportedFolders([
			outcome("a", "/home/demo/one"),
			outcome("b", "/home/demo/one"),
			outcome("c", "/home/demo/two"),
			outcome("d"),
		])
	).toBe(2);
	expect(folders).toEqual(["/home/demo/one", "/home/demo/two"]);
});

test(
	"starts the import as an operation and reads its results from the node",
	async () => {
		answers[`POST ${RUN}`] = { operation: wire() };
		answers[`GET ${READ}`] = wire({
			progress: { done: 2, total: 2 },
			result: { results: BOTH, root: "/home/demo/.claude" },
			status: "succeeded",
			updatedAt: at(5),
		});
		await mount();
		expect(view.operations).toEqual([]);

		expect(await start()).toEqual([]);
		await until(() => view.settled, "the final record");

		const sent = requests("POST", RUN);
		expect(sent).toHaveLength(1);
		expect(sent[0]?.body).toMatchObject({
			async: true,
			items: [
				{ id: "skills/a", kind: "skill" },
				{ id: "CLAUDE.md", kind: "instructions" },
			],
			path: "/home/demo/.claude",
		});
		expect(
			(sent[0]?.body as { idempotencyKey?: string }).idempotencyKey
		).toMatch(KEY);
		expect(view.active).toBe(false);
		expect(view.operations.map((o) => o.status)).toEqual(["succeeded"]);
		expect(view.outcomes.map((o) => o.id)).toEqual(["skills/a", "CLAUDE.md"]);
		expect([...new Set(folders)]).toEqual(["/home/demo/project"]);

		// Back to the picker. The record stays in the mirror.
		act(() => view.clear());
		expect(view.operations).toEqual([]);
		expect(useOperationsStore.getState().operations.op_1?.status).toBe(
			"succeeded"
		);
	},
	LONG
);

test(
	"an older node answers with the results of the whole batch",
	async () => {
		answers[`POST ${RUN}`] = { results: BOTH, root: "/home/demo/.claude" };
		await mount();

		const plain = await start();

		expect(plain.map((o) => o.id)).toEqual(["skills/a", "CLAUDE.md"]);
		expect(view.operations).toEqual([]);
		expect(folders).toEqual(["/home/demo/project"]);
		expect(requests("GET", READ)).toEqual([]);
	},
	LONG
);

test(
	"stop asks the node to cancel and retry starts the import again",
	async () => {
		answers[`POST ${RUN}`] = { operation: wire() };
		answers[`GET ${READ}`] = wire({
			cursor: { results: [BOTH[0]] },
			progress: { done: 1, total: 2 },
			updatedAt: at(1),
		});
		answers[`POST ${READ}/cancel`] = wire({
			cancelRequested: true,
			progress: { done: 1, total: 2 },
			updatedAt: at(2),
		});
		answers[`POST ${READ}/retry`] = wire({
			attempt: 2,
			progress: { done: 1, total: 2 },
			status: "queued",
			updatedAt: at(4),
		});
		await mount();
		await start();
		await until(
			() => view.outcomes.length === 1,
			"the checkpoint of the running import"
		);
		expect(view.active).toBe(true);
		expect(view.settled).toBe(false);

		await act(async () => {
			await view.stop();
		});
		expect(requests("POST", `${READ}/cancel`)).toHaveLength(1);
		expect(view.operations[0]?.cancelRequested).toBe(true);
		// The checkpoint read before is kept under the newer summary.
		expect(view.outcomes.map((o) => o.id)).toEqual(["skills/a"]);

		answers[`GET ${READ}`] = wire({
			cursor: { results: [BOTH[0]] },
			progress: { done: 1, total: 2 },
			status: "cancelled",
			updatedAt: at(3),
		});
		await until(
			() => view.operations[0]?.status === "cancelled" && view.settled,
			"the stopped import"
		);

		answers[`GET ${READ}`] = wire({
			attempt: 2,
			cursor: { results: [BOTH[0]] },
			progress: { done: 1, total: 2 },
			status: "queued",
			updatedAt: at(4),
		});
		await act(async () => {
			await view.retry();
		});
		expect(requests("POST", `${READ}/retry`)).toHaveLength(1);
		expect(view.operations[0]?.status).toBe("queued");
		expect(view.active).toBe(true);
	},
	LONG
);

test(
	"an operation the node no longer has leaves the surface",
	async () => {
		answers[`POST ${RUN}`] = { operation: wire() };
		answers[`GET ${READ}`] = null;
		await mount();
		await start();
		await until(
			() => requests("GET", READ).length > 0 && view.operations.length === 0,
			"the removal"
		);
		expect(useOperationsStore.getState().operations).toEqual({});
		expect(useOperationsStore.getState().surfaces).toEqual({});
	},
	LONG
);

test(
	"a surface opened after a reload finds the import that still runs",
	async () => {
		answers[`GET ${READ}`] = wire({
			cursor: { results: [BOTH[0]] },
			ownerUserId: ME,
			progress: { done: 1, total: 2 },
			updatedAt: at(1),
		});
		mirror(wire({ ownerUserId: ME, progress: { done: 1, total: 2 } }));
		await mount();
		await until(() => view.outcomes.length === 1, "the checkpoint");
		expect(view.operations.map((o) => o.id)).toEqual(["op_1"]);
		expect(view.active).toBe(true);
		expect(requests("POST", RUN)).toEqual([]);
	},
	LONG
);

/** Put one operation into the mirror, as the app-wide list would. */
function mirror(record: Record<string, unknown>) {
	const operation = parseOperation(record);
	if (!operation) {
		throw new Error("the fixture is not an operation");
	}
	useOperationsStore.getState().applySnapshot([operation]);
}

/** Let the surface run its effects for a while. */
async function settle() {
	await act(async () => {
		await Bun.sleep(300);
	});
}

test(
	"another user's running import is not the surface's: no read, no stop, no retry, no folders",
	async () => {
		// The admin of an org-bound node sees a member's import in the list.
		mirror(wire({ ownerUserId: "user-b", progress: { done: 1, total: 2 } }));
		await mount();
		await settle();

		expect(view.operations).toEqual([]);
		expect(view.active).toBe(false);
		await act(async () => {
			await view.stop();
			await view.retry();
		});
		expect(seen).toEqual([]);
		expect(folders).toEqual([]);
		// The member's import is still in the mirror; only the surface ignores it.
		expect(useOperationsStore.getState().operations.op_1?.ownerUserId).toBe(
			"user-b"
		);
	},
	LONG
);

/** A session whose user cannot be named: a placeholder account (the offline
 *  sign-in fallback) or an unverified bearer. */
function unnamedSession() {
	unregisterOwner();
	unregisterOwner = registerVaultOwnerSource({
		accountCount: () => 1,
		verifiedActiveUserId: () => null,
	});
}

/** Talk to a node of this machine with its node token and no delegation, and
 *  make it the active node. */
function localNode() {
	target = { token: "node-a", url: target.url };
	useNodeStore.setState({ nodes: [{ name: "test-node", ...target }] });
}

/** Press Stop and Retry on whatever the surface shows. */
async function stopAndRetry() {
	await act(async () => {
		await view.stop();
		await view.retry();
	});
}

test(
	"an unnamed session with a delegation takes no ownerless import: no operation, no request, no folders",
	async () => {
		// The delegation is sent as it is, so Core may take this caller for the
		// node's admin and list an import that was started without an identity.
		unnamedSession();
		mirror(wire({ progress: { done: 1, total: 2 } }));
		await mount();
		await settle();

		expect(view.operations).toEqual([]);
		expect(view.active).toBe(false);
		await stopAndRetry();
		expect(seen).toEqual([]);
		expect(folders).toEqual([]);
		// The import is still in the mirror; only the surface ignores it.
		expect(useOperationsStore.getState().operations.op_1?.id).toBe("op_1");
	},
	LONG
);

test(
	"an unnamed session with a live bearer takes no ownerless import on a local node",
	async () => {
		// A placeholder account: the bearer is live and the client mints the
		// account JWT from it, but no user id is verified.
		localNode();
		unnamedSession();
		localStorage.setItem(SESSION_BEARER_KEY, "placeholder-bearer");
		mirror(wire({ progress: { done: 1, total: 2 } }));
		await mount();
		await settle();

		expect(view.operations).toEqual([]);
		expect(view.active).toBe(false);
		await stopAndRetry();
		expect(seen).toEqual([]);
		expect(folders).toEqual([]);
		// The import is still in the mirror; only the surface ignores it.
		expect(useOperationsStore.getState().operations.op_1?.id).toBe("op_1");
	},
	LONG
);

test(
	"signed out on a local node, the one operator finds the ownerless import again",
	async () => {
		// No bearer and no delegation: the client presents no identity, so its
		// own starts are ownerless too.
		localNode();
		unregisterOwner();
		unregisterOwner = registerVaultOwnerSource({
			accountCount: () => 0,
			verifiedActiveUserId: () => null,
		});
		answers[`GET ${READ}`] = wire({
			cursor: { results: [BOTH[0]] },
			progress: { done: 1, total: 2 },
			updatedAt: at(1),
		});
		mirror(wire({ progress: { done: 1, total: 2 } }));
		await mount();
		await until(() => view.outcomes.length === 1, "the checkpoint");
		expect(view.operations.map((o) => o.id)).toEqual(["op_1"]);
		expect(view.active).toBe(true);
	},
	LONG
);

test(
	"a surface whose node is not the active node adopts nothing",
	async () => {
		// Onboarding may set up another node than the one the mirror follows.
		useNodeStore.setState({
			nodes: [{ name: "test-node", token: "other", url: "http://127.0.0.1:1" }],
		});
		mirror(wire({ ownerUserId: ME, progress: { done: 1, total: 2 } }));
		await mount();
		await settle();

		expect(view.operations).toEqual([]);
		expect(seen).toEqual([]);
		// The mirror keeps the active node's operation: no read answered 404 for it.
		expect(useOperationsStore.getState().operations.op_1?.id).toBe("op_1");
	},
	LONG
);
