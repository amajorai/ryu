import { expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";

if (globalThis.document === undefined) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const { createRoot } = await import("react-dom/client");
const { useModalLayerOpen } = await import("./use-modal-layer-open.ts");

/** Lets the MutationObserver deliver, then flushes the state it set. */
async function settle() {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
}

function portal(slot: string, sidebar?: string) {
	const container = document.createElement("div");
	const layer = document.createElement("div");
	layer.dataset.slot = slot;
	if (sidebar) {
		layer.dataset.sidebar = sidebar;
	}
	container.append(layer);
	return container;
}

test("follows modal layers portaled into the document, not the navigation sheet", async () => {
	const seen: boolean[] = [];
	function Probe() {
		seen.push(useModalLayerOpen());
		return null;
	}
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	await act(async () => {
		root.render(<Probe />);
	});
	const latest = () => seen.at(-1);
	expect(latest()).toBe(false);

	// Streamed transcript text: no layer.
	const text = document.createElement("span");
	host.append(text);
	text.append("chunk");
	await settle();
	expect(latest()).toBe(false);

	for (const slot of [
		"dialog-overlay",
		"alert-dialog-overlay",
		"drawer-overlay",
		"sheet-content",
	]) {
		const layer = portal(slot);
		document.body.append(layer);
		await settle();
		expect(latest()).toBe(true);
		// Unrelated removals while it is open keep it open.
		text.remove();
		await settle();
		expect(latest()).toBe(true);
		host.append(text);
		layer.remove();
		await settle();
		expect(latest()).toBe(false);
	}

	// A layer rendered into a portal that was mounted empty.
	const empty = document.createElement("div");
	document.body.append(empty);
	await settle();
	empty.append(portal("dialog-overlay"));
	await settle();
	expect(latest()).toBe(true);
	empty.remove();
	await settle();
	expect(latest()).toBe(false);

	// The phone-width navigation sheet leaves the cluster on top.
	const navigation = portal("sheet-content", "sidebar");
	document.body.append(navigation);
	await settle();
	expect(latest()).toBe(false);
	navigation.remove();

	await act(async () => {
		root.unmount();
	});
	host.remove();
});

test("starts open when a layer is already in the document", async () => {
	const layer = portal("dialog-overlay");
	document.body.append(layer);
	const seen: boolean[] = [];
	function Probe() {
		seen.push(useModalLayerOpen());
		return null;
	}
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	await act(async () => {
		root.render(<Probe />);
	});
	expect(seen.at(-1)).toBe(true);
	await act(async () => {
		root.unmount();
	});
	host.remove();
	layer.remove();
});
