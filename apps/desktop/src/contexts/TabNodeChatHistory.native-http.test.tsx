// A tab bound to another computer reads its history from THAT computer. The
// root provider stays on the default computer, a sibling tab without a binding
// keeps reading the default, and a late answer from a computer the tab has left
// is dropped instead of landing in the tab or the root.
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import type { Root } from "react-dom/client";

const nativeFetch = globalThis.fetch;
const NativeResponse = globalThis.Response;
if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
globalThis.fetch = nativeFetch;
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const { createRoot } = await import("react-dom/client");
const { useNodeStore } = await import("@/src/store/useNodeStore.ts");
const { ChatHistoryProvider, useChatHistoryContext } = await import(
	"@/src/contexts/ChatHistoryContext.tsx"
);
const { CurrentTabIdProvider } = await import("@/src/contexts/TabsContext.tsx");

type Slot = "A" | "B" | "C";
const SLOTS: Slot[] = ["A", "B", "C"];
const initialStore = useNodeStore.getState();
const calls: { slot: Slot; path: string; authorization: string | null }[] = [];
const unexpected: string[] = [];
let holdB = false;
const releases: (() => void)[] = [];

const server: Bun.Server<undefined> = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch: async (request: Request): Promise<Response> => {
		const url = new URL(request.url);
		const [, prefix, ...rest] = url.pathname.split("/");
		const slot = SLOTS.find((s) => s === prefix);
		const authorization = request.headers.get("authorization");
		if (!slot || authorization !== `Bearer token-${slot}`) {
			unexpected.push(`Bad target: ${url.pathname} ${authorization}`);
			return NativeResponse.json({}, { status: 403 });
		}
		const route = `/${rest.join("/")}`;
		calls.push({ slot, path: route, authorization });
		if (slot === "B" && holdB) {
			await new Promise<void>((resolve) => {
				releases.push(resolve);
			});
		}
		if (route === "/api/conversations") {
			return NativeResponse.json({
				conversations: [
					{
						id: "shared",
						title: `${slot} thread`,
						folder_path: null,
						created_at: 1,
						updated_at: 2,
						message_count: 1,
						agent_id: null,
						branch: null,
						worktree_path: null,
						run_status: null,
					},
				],
			});
		}
		if (route === "/api/conversations/shared") {
			return NativeResponse.json({
				messages: [
					{
						id: `m-${slot}`,
						role: "user",
						content: `hello from ${slot}`,
						created_at: 1,
					},
				],
				has_older_messages: false,
			});
		}
		unexpected.push(`Unsupported ${request.method} ${url.pathname}`);
		return NativeResponse.json({}, { status: 404 });
	},
});

const nodes = SLOTS.map((slot) => ({
	name: slot,
	url: `${server.url.origin}/${slot}`,
	token: `token-${slot}`,
}));

type History = ReturnType<typeof useChatHistoryContext>;
const seen: Record<string, History> = {};
function Probe({ name }: { name: string }) {
	seen[name] = useChatHistoryContext();
	return null;
}

let root: Root | undefined;
async function mount() {
	root = createRoot(document.createElement("div"));
	await act(async () =>
		root?.render(
			<ChatHistoryProvider>
				<Probe name="root" />
				<CurrentTabIdProvider tabId="tab-bound">
					<Probe name="bound" />
				</CurrentTabIdProvider>
				<CurrentTabIdProvider tabId="tab-plain">
					<Probe name="plain" />
				</CurrentTabIdProvider>
			</ChatHistoryProvider>
		)
	);
}
async function until(check: () => boolean) {
	for (let i = 0; i < 250; i++) {
		if (check()) {
			return;
		}
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 4));
		});
	}
	if (!check()) {
		throw new Error("Timed out waiting for the condition");
	}
}
const titles = (name: string) => seen[name]?.conversations.map((c) => c.title);

beforeEach(() => {
	calls.length = 0;
	unexpected.length = 0;
	holdB = false;
	releases.length = 0;
	localStorage.clear();
	useNodeStore.setState({
		nodes,
		defaultNode: "A",
		autoSelect: false,
		autoSelectedNode: null,
		tabOverrides: { "tab-bound": "B" },
	});
});
afterEach(async () => {
	for (const release of releases) {
		release();
	}
	await act(async () => root?.unmount());
	root = undefined;
	useNodeStore.setState(initialStore, true);
	if (unexpected.length > 0) {
		throw new Error(`Unexpected requests: ${unexpected.join(", ")}`);
	}
});
afterAll(() => {
	server.stop(true);
	globalThis.fetch = nativeFetch;
});

test("a bound tab lists and loads from its own computer; a sibling stays on the default", async () => {
	await mount();
	await until(
		() =>
			titles("bound")?.[0] === "B thread" && titles("root")?.[0] === "A thread"
	);
	expect(titles("plain")).toEqual(["A thread"]);

	const bound = await seen.bound.loadMessagesPageResult("shared");
	const plain = await seen.plain.loadMessagesPageResult("shared");
	expect(bound.messages.map((m) => m.content)).toEqual(["hello from B"]);
	expect(plain.messages.map((m) => m.content)).toEqual(["hello from A"]);
	expect(calls.filter((c) => c.path === "/api/conversations/shared")).toEqual([
		{
			slot: "B",
			path: "/api/conversations/shared",
			authorization: "Bearer token-B",
		},
		{
			slot: "A",
			path: "/api/conversations/shared",
			authorization: "Bearer token-A",
		},
	]);
});

test("a binding to the default computer by name keeps the root provider", async () => {
	useNodeStore.setState({ tabOverrides: { "tab-bound": "A" } });
	await mount();
	await until(() => titles("root")?.[0] === "A thread");
	expect(seen.bound).toBe(seen.root);
	expect(calls.filter((c) => c.path === "/api/conversations")).toHaveLength(1);
});

test("a late answer from a computer the tab has left is dropped", async () => {
	holdB = true;
	await mount();
	await until(() => releases.length === 1);
	await act(async () => {
		useNodeStore.getState().setTabOverride("tab-bound", "C");
	});
	await until(() => titles("bound")?.[0] === "C thread");
	await act(async () => {
		for (const release of releases.splice(0)) {
			release();
		}
		await new Promise((resolve) => setTimeout(resolve, 20));
	});
	expect(titles("bound")).toEqual(["C thread"]);
	expect(titles("root")).toEqual(["A thread"]);
});
