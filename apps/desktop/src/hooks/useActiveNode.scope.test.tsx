import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";
import type { Root } from "react-dom/client";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { createRoot } = await import("react-dom/client");
const { NodeScopeProvider } = await import(
	"@/src/contexts/NodeScopeContext.tsx"
);
const { CurrentTabIdProvider } = await import("@/src/contexts/TabsContext.tsx");
const { LOCAL_FALLBACK, useNodeStore } = await import(
	"@/src/store/useNodeStore.ts"
);
const {
	resolveScopedNode,
	useActiveNode,
	useActiveNodeGetter,
	useActiveTarget,
	useActiveTargetGetter,
} = await import("./useActiveNode.ts");

type Node = ReturnType<typeof useActiveNode>;

const initialStore = useNodeStore.getState();
const nodeA: Node = {
	name: "a",
	url: "https://a.example",
	token: "token-a",
	userJwt: "jwt-a",
};
const nodeB: Node = {
	name: "b",
	url: "https://b.example",
	token: "token-b",
	userJwt: "jwt-b",
};
const nodeC: Node = {
	name: "c",
	url: "https://c.example",
	token: "token-c",
	userJwt: null,
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
	localStorage.clear();
	useNodeStore.setState({
		nodes: [nodeA, nodeB, nodeC],
		defaultNode: "a",
		autoSelect: false,
		autoSelectedNode: null,
		tabOverrides: {},
	});
	container = document.createElement("div");
	root = createRoot(container);
});

afterEach(async () => {
	await act(async () => root.unmount());
	useNodeStore.setState(initialStore, true);
});

afterAll(() => {
	useNodeStore.setState(initialStore, true);
});

function stateWith(
	overrides: Partial<ReturnType<typeof useNodeStore.getState>>
) {
	useNodeStore.setState(overrides);
	return useNodeStore.getState();
}

test("resolveScopedNode: scope beats tab override, auto-select and default", () => {
	const state = stateWith({
		tabOverrides: { tab1: "c" },
		autoSelect: true,
		autoSelectedNode: "a",
	});
	expect(resolveScopedNode(state, "b", "tab1")).toBe(nodeB);
	// Without a scope, the store's precedence applies unchanged.
	expect(resolveScopedNode(state, undefined, "tab1")).toBe(nodeC);
	expect(resolveScopedNode(state, undefined, undefined)).toBe(nodeA);
});

test("resolveScopedNode: an unknown scope falls back to normal resolution", () => {
	const state = stateWith({ defaultNode: "c" });
	expect(resolveScopedNode(state, "gone", undefined)).toBe(nodeC);
	const empty = stateWith({ nodes: [], defaultNode: "a" });
	expect(resolveScopedNode(empty, "gone", undefined)).toBe(LOCAL_FALLBACK);
});

interface Captured {
	getNode?: () => Node;
	getTarget?: () => unknown;
	node?: Node;
	target?: unknown;
}

function Probe({ into }: { into: Captured }) {
	into.node = useActiveNode();
	into.getNode = useActiveNodeGetter();
	into.target = useActiveTarget();
	into.getTarget = useActiveTargetGetter();
	return null;
}

async function render(ui: ReactNode) {
	await act(async () => {
		root.render(ui);
	});
}

test("outside a provider the hooks equal getActiveNode(undefined)", async () => {
	const seen: Captured = {};
	await render(<Probe into={seen} />);
	expect(seen.node).toBe(useNodeStore.getState().getActiveNode(undefined));
	expect(seen.getNode?.()).toBe(nodeA);
	expect(seen.target).toEqual({
		url: nodeA.url,
		token: nodeA.token,
		userJwt: nodeA.userJwt,
	});
	// A default change is followed live, exactly as before scoping existed.
	await act(async () => {
		useNodeStore.setState({ defaultNode: "c" });
	});
	expect(seen.node).toBe(nodeC);
	expect(seen.getTarget?.()).toEqual({
		url: nodeC.url,
		token: nodeC.token,
		userJwt: null,
	});
});

test("inside a provider the scope wins over the tab override", async () => {
	useNodeStore.setState({ tabOverrides: { tab1: "c" } });
	const seen: Captured = {};
	await render(
		<CurrentTabIdProvider tabId="tab1">
			<NodeScopeProvider nodeName="b">
				<Probe into={seen} />
			</NodeScopeProvider>
		</CurrentTabIdProvider>
	);
	expect(seen.node).toBe(nodeB);
	expect(seen.getNode?.()).toBe(nodeB);
	expect(seen.getTarget?.()).toEqual({
		url: nodeB.url,
		token: nodeB.token,
		userJwt: nodeB.userJwt,
	});
	// The app-wide default moving does not move a scoped surface.
	await act(async () => {
		useNodeStore.setState({ defaultNode: "c" });
	});
	expect(seen.node).toBe(nodeB);
});

test("a scope naming a removed node falls back to the default", async () => {
	const seen: Captured = {};
	await render(
		<NodeScopeProvider nodeName="b">
			<Probe into={seen} />
		</NodeScopeProvider>
	);
	expect(seen.node).toBe(nodeB);
	await act(async () => {
		useNodeStore.setState({ nodes: [nodeA, nodeC] });
	});
	expect(seen.node).toBe(nodeA);
	expect(seen.getNode?.()).toBe(nodeA);
});

test("getter identity changes when the scope changes", async () => {
	const seen: Captured = {};
	await render(
		<NodeScopeProvider nodeName="b">
			<Probe into={seen} />
		</NodeScopeProvider>
	);
	const firstGetter = seen.getNode;
	const firstTargetGetter = seen.getTarget;
	const firstTarget = seen.target;
	// Same scope, unrelated store change: identities are stable.
	await act(async () => {
		useNodeStore.setState({ defaultNode: "c" });
	});
	expect(seen.getNode).toBe(firstGetter);
	expect(seen.getTarget).toBe(firstTargetGetter);
	expect(seen.target).toBe(firstTarget);
	await render(
		<NodeScopeProvider nodeName="c">
			<Probe into={seen} />
		</NodeScopeProvider>
	);
	expect(seen.getNode).not.toBe(firstGetter);
	expect(seen.getTarget).not.toBe(firstTargetGetter);
	expect(seen.getNode?.()).toBe(nodeC);
});
