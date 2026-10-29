// Lifecycle of the node settings dialog's computer scope: the shell owns it,
// every opening starts on the app-wide computer, a removed computer drops the
// scope, a scope change remounts the content, and the dialog's own status poll
// follows the scoped computer. The picker is replaced by plain buttons so the
// test drives `onScopeChange` without a real menu.
import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import type { Root } from "react-dom/client";

const nativeFetch = globalThis.fetch;
const NativeResponse = globalThis.Response;
const NativeAbortController = globalThis.AbortController;
const NativeAbortSignal = globalThis.AbortSignal;
if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
// The status poller hands `AbortSignal.any(...)` to the native fetch, which
// only accepts the runtime's own signals, not happy-dom's.
globalThis.AbortController = NativeAbortController;
globalThis.AbortSignal = NativeAbortSignal;
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

interface Call {
	authorization: string | null;
	path: string;
	slot: string;
}
let calls: Call[] = [];
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch(request) {
		const url = new URL(request.url);
		const [, slot = ""] = url.pathname.split("/");
		calls.push({
			slot,
			path: url.pathname.slice(slot.length + 1),
			authorization: request.headers.get("authorization"),
		});
		if (
			request.method === "GET" &&
			url.pathname.includes("/api/preferences/")
		) {
			return NativeResponse.json({ error: "unset" }, { status: 404 });
		}
		return NativeResponse.json({});
	},
});
globalThis.fetch = Object.assign(
	(...args: Parameters<typeof nativeFetch>) => {
		const input = args[0];
		const href =
			typeof input === "string"
				? input
				: input instanceof URL
					? input.href
					: input.url;
		if (new URL(href).origin !== server.url.origin) {
			return Promise.reject(new Error("Unowned egress"));
		}
		return nativeFetch(...args);
	},
	{ preconnect: nativeFetch.preconnect }
);

const pickerScopes: Array<string | undefined> = [];
let changeScope: ((name: string) => void) | undefined;
mock.module("@/src/components/gateway/GatewayNodeScopePicker.tsx", () => ({
	nodeSettingsLabel: (node: { name: string }) => node.name,
	GatewayNodeScopePicker: ({
		scope,
		onScopeChange,
	}: {
		onScopeChange: (name: string) => void;
		scope?: string;
	}) => {
		pickerScopes.push(scope);
		changeScope = onScopeChange;
		return <span data-testid="picker-scope">{scope ?? "(app-wide)"}</span>;
	},
}));

const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import(
	"@tanstack/react-query"
);
const { MemoryRouter } = await import("react-router-dom");
const { EntitlementProvider } = await import(
	"@/src/contexts/entitlement-context.tsx"
);
const { useNodeStore } = await import("@/src/store/useNodeStore.ts");
const { GatewayDialog } = await import("./GatewayDialog.tsx");

const initialStore = useNodeStore.getState();
const nodeA = {
	name: "a",
	url: `${server.url.origin}/A`,
	token: "token-A",
	userJwt: null,
};
const nodeB = {
	name: "b",
	url: `${server.url.origin}/B`,
	token: "token-B",
	userJwt: null,
};

let container: HTMLDivElement;
let root: Root | null = null;
let client: InstanceType<typeof QueryClient>;

beforeEach(() => {
	calls = [];
	pickerScopes.length = 0;
	changeScope = undefined;
	localStorage.clear();
	useNodeStore.setState({
		nodes: [nodeA, nodeB],
		defaultNode: "a",
		autoSelect: false,
		autoSelectedNode: null,
		tabOverrides: {},
	});
	client = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: 0 } },
	});
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});

afterEach(async () => {
	await act(async () => {
		root?.unmount();
		root = null;
	});
	client.clear();
	container.remove();
	useNodeStore.setState(initialStore, true);
});

afterAll(() => {
	globalThis.fetch = nativeFetch;
	server.stop(true);
});

async function settle(ms = 120) {
	await act(async () => {
		await new Promise<void>((resolve) => setTimeout(resolve, ms));
	});
}

async function renderDialog(open: boolean) {
	await act(async () => {
		root?.render(
			<QueryClientProvider client={client}>
				<EntitlementProvider>
					<MemoryRouter>
						<GatewayDialog
							defaultSection="overview"
							onOpenChange={() => undefined}
							open={open}
						/>
					</MemoryRouter>
				</EntitlementProvider>
			</QueryClientProvider>
		);
	});
	await settle();
}

function currentScope(): string | undefined {
	return pickerScopes.at(-1);
}

function statusPolls(slot: string): Call[] {
	return calls.filter(
		(call) => call.slot === slot && call.path === "/api/gateway/status"
	);
}

async function pick(name: string) {
	await act(async () => {
		changeScope?.(name);
	});
	await settle();
}

test("opens on the app-wide computer and polls its status", async () => {
	await renderDialog(true);
	expect(currentScope()).toBeUndefined();
	expect(statusPolls("A").length).toBeGreaterThan(0);
	expect(statusPolls("B")).toEqual([]);
});

test("picking a computer scopes the dialog and its status poll, not the app", async () => {
	await renderDialog(true);
	calls = [];
	await pick("b");
	expect(currentScope()).toBe("b");
	expect(statusPolls("B").length).toBeGreaterThan(0);
	expect(
		statusPolls("B").every((call) => call.authorization === "Bearer token-B")
	).toBe(true);
	expect(statusPolls("A")).toEqual([]);
	// Chats keep using the app-wide computer.
	expect(useNodeStore.getState().defaultNode).toBe("a");
});

test("reopening the dialog resets the scope to the app-wide computer", async () => {
	await renderDialog(true);
	await pick("b");
	expect(currentScope()).toBe("b");
	await renderDialog(false);
	await renderDialog(true);
	expect(currentScope()).toBeUndefined();
});

test("removing the scoped computer clears the scope", async () => {
	await renderDialog(true);
	await pick("b");
	await act(async () => {
		useNodeStore.setState({ nodes: [nodeA] });
	});
	await settle();
	expect(currentScope()).toBeUndefined();
	// Re-adding a computer with that name does not resurrect the old scope.
	await act(async () => {
		useNodeStore.setState({ nodes: [nodeA, nodeB] });
	});
	await settle();
	expect(currentScope()).toBeUndefined();
});

test("a scope change remounts the section content", async () => {
	await renderDialog(true);
	const before = container.ownerDocument.querySelector(
		'[data-testid="picker-scope"]'
	);
	expect(before).not.toBeNull();
	const contentBefore =
		document.body.querySelector("h2")?.parentElement?.nextElementSibling;
	expect(contentBefore).toBeTruthy();
	await pick("b");
	const contentAfter =
		document.body.querySelector("h2")?.parentElement?.nextElementSibling;
	expect(contentAfter).toBeTruthy();
	expect(contentAfter).not.toBe(contentBefore);
});
