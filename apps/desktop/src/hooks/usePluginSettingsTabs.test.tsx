import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import type { Root } from "react-dom/client";
import type { ApiTarget } from "@/src/lib/api/client.ts";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const fetched: ApiTarget[] = [];
mock.module("@/src/lib/api/plugins.ts", () => ({
	getPluginContributions: (target: ApiTarget) => {
		fetched.push(target);
		return Promise.resolve({ settings_tabs: [] });
	},
}));

const { createRoot } = await import("react-dom/client");
const { NodeScopeProvider } = await import(
	"@/src/contexts/NodeScopeContext.tsx"
);
const { useNodeStore } = await import("@/src/store/useNodeStore.ts");
const { usePluginSettingsTabs } = await import("./usePluginSettingsTabs.ts");

const initialStore = useNodeStore.getState();
let reload: (() => void) | undefined;
let container: HTMLDivElement;
let root: Root;

function Harness() {
	reload = usePluginSettingsTabs().reload;
	return null;
}

beforeEach(() => {
	fetched.length = 0;
	localStorage.clear();
	useNodeStore.setState({
		nodes: [
			{ name: "a", url: "https://a.example", token: "token-a" },
			{ name: "b", url: "https://b.example", token: "token-b" },
		],
		defaultNode: "a",
		autoSelect: false,
		tabOverrides: {},
	});
	container = document.createElement("div");
	root = createRoot(container);
});

afterEach(async () => {
	await act(async () => root.unmount());
	useNodeStore.setState(initialStore, true);
});

test("refetches when the active computer changes", async () => {
	await act(async () => {
		root.render(<Harness />);
	});
	expect(fetched.map((target) => target.url)).toEqual(["https://a.example"]);
	await act(async () => {
		useNodeStore.setState({ defaultNode: "b" });
	});
	expect(fetched.map((target) => target.url)).toEqual([
		"https://a.example",
		"https://b.example",
	]);
	expect(fetched.at(-1)?.token).toBe("token-b");
});

test("refetches on reload()", async () => {
	await act(async () => {
		root.render(<Harness />);
	});
	await act(async () => {
		reload?.();
	});
	expect(fetched.map((target) => target.url)).toEqual([
		"https://a.example",
		"https://a.example",
	]);
});

test("lists the dialog's scoped computer inside a NodeScopeProvider", async () => {
	await act(async () => {
		root.render(
			<NodeScopeProvider nodeName="b">
				<Harness />
			</NodeScopeProvider>
		);
	});
	expect(fetched.map((target) => target.url)).toEqual(["https://b.example"]);
});
