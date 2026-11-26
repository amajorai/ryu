import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

// Inactive tabs stay mounted. When an app's tab leaves the front, the text it
// published with `ui.updateModelContext` must leave the Ask Ryu turn with it,
// and come back when the tab is in front again.
if (globalThis.document === undefined) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let inFront = true;
mock.module("@/src/contexts/TabsContext.tsx", () => ({
	useIsActiveTab: () => inFront,
}));

const { modelContextParts, useModelContextStore } = await import(
	"@ryu/app-host/model-context"
);
const { usePluginAssistantBridge } = await import(
	"./PluginHostPanel-assistant-bridge.ts"
);

const OWNER = "plugin:com.example.evil:page:n1";

function Panel() {
	usePluginAssistantBridge(OWNER);
	return null;
}

let container: HTMLDivElement;
let root: Root;

function renderPanel(front: boolean) {
	inFront = front;
	act(() => {
		root.render(<Panel />);
	});
}

beforeEach(() => {
	useModelContextStore.setState({ entries: {}, held: {} });
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});

afterEach(() => {
	act(() => {
		root.unmount();
	});
	container.remove();
});

test("an app's model context leaves the Ask Ryu turn on blur and returns on focus", () => {
	renderPanel(true);
	const state = useModelContextStore
		.getState()
		.update("assistant", OWNER, { content: [{ type: "text", text: "x" }] });
	expect(modelContextParts("assistant")).toHaveLength(1);

	renderPanel(false);
	expect(modelContextParts("assistant")).toEqual([]);
	// Its own frame still reads the same accepted state.
	expect(useModelContextStore.getState().get("assistant", OWNER)).toEqual(
		state
	);

	renderPanel(true);
	expect(modelContextParts("assistant")).toHaveLength(1);
	expect(useModelContextStore.getState().entries[OWNER]?.state).toEqual(state);
});

test("closing the panel drops what a background tab still held", () => {
	renderPanel(true);
	useModelContextStore
		.getState()
		.update("assistant", OWNER, { content: [{ type: "text", text: "x" }] });
	renderPanel(false);
	expect(modelContextParts("assistant")).toEqual([]);
	act(() => {
		root.unmount();
	});
	expect(useModelContextStore.getState().get("assistant", OWNER)).toBeNull();
	root = createRoot(container);
});
