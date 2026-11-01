import { afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useAfterDragStart } from "./useAfterDragStart.ts";

if (globalThis.document === undefined) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const seen: boolean[] = [];
let root: Root | null = null;

function Probe({ dragging }: { dragging: boolean }) {
	seen.push(useAfterDragStart(dragging));
	return null;
}

function nextFrame() {
	return new Promise<void>((resolve) => {
		requestAnimationFrame(() => resolve());
	});
}

afterEach(() => {
	act(() => root?.unmount());
	root = null;
	seen.length = 0;
});

test("stays off for the render that starts the drag, then turns on a frame later", async () => {
	root = createRoot(document.createElement("div"));
	act(() => root?.render(<Probe dragging={false} />));
	act(() => root?.render(<Probe dragging />));
	// The dragstart render itself must not show drag-only layout.
	expect(seen.at(-1)).toBe(false);
	await act(async () => {
		await nextFrame();
	});
	expect(seen.at(-1)).toBe(true);
});

test("turns off in the same render the drag ends", async () => {
	root = createRoot(document.createElement("div"));
	act(() => root?.render(<Probe dragging />));
	await act(async () => {
		await nextFrame();
	});
	expect(seen.at(-1)).toBe(true);
	act(() => root?.render(<Probe dragging={false} />));
	expect(seen.at(-1)).toBe(false);
});
