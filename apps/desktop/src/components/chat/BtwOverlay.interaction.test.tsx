import { afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Browser globals must stay in an isolated Bun process for this interaction.
if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const { act, createElement, useState } = await import("react");
const { createRoot } = await import("react-dom/client");
const { BtwOverlay } = await import("./BtwOverlay.tsx");
let root: ReturnType<typeof createRoot> | null = null;

afterEach(async () => {
	await act(async () => root?.unmount());
	root = null;
	document.body.replaceChildren();
});

test("the side-question streaming Stop aborts its host request without dismissing or sending another question", async () => {
	const request = new AbortController();
	let stops = 0;
	let closes = 0;
	let asks = 0;
	const question = "Explain the current plan";
	function Host() {
		const [loading, setLoading] = useState(true);
		return createElement(BtwOverlay, {
			state: { answer: null, error: null, loading, model: null, question },
			onAsk: () => {
				asks += 1;
			},
			onClose: () => {
				closes += 1;
			},
			onStop: () => {
				stops += 1;
				request.abort();
				setLoading(false);
			},
		});
	}
	const container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	await act(async () => root?.render(createElement(Host)));
	const stop = document.querySelector<HTMLButtonElement>(
		'button[aria-label="Stop"]'
	);
	expect(stop).not.toBeNull();
	expect(stop?.disabled).toBe(false);
	await act(async () => stop?.click());
	expect(stops).toBe(1);
	expect(request.signal.aborted).toBe(true);
	expect(closes).toBe(0);
	expect(asks).toBe(0);
	expect(document.querySelector('button[aria-label="Stop"]')).toBeNull();
	expect(document.body.textContent).toContain(question);
	expect(document.body.textContent).toContain("Side question");
});
