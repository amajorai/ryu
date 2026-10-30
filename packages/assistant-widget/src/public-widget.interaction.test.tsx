// The closed launcher is all a page pays for: no guest status request, no page
// walk and no chat chunk until the visitor shows intent or opens Ask Ryu.
// happy-dom is registered before React DOM and the widget load.
import { afterAll, afterEach, expect, mock, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const registeredHere = !GlobalRegistrator.isRegistered;
if (registeredHere) {
	GlobalRegistrator.register({ url: "https://docs.example/install" });
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const originalFetch = globalThis.fetch;
const fetchMock = mock(async () => Response.json({ available: false }));
globalThis.fetch = Object.assign(fetchMock, {
	preconnect: originalFetch.preconnect,
});

const { RyuAssistantWidget } = await import("./public-widget.tsx");
const { assistantSessionLoadStatus, loadAssistantSession } = await import(
	"./deferred-session.tsx"
);

let root: Root | null = null;

afterEach(() => {
	act(() => root?.unmount());
	root = null;
	document.body.innerHTML = "";
});

afterAll(async () => {
	globalThis.fetch = originalFetch;
	if (registeredHere) {
		await GlobalRegistrator.unregister();
	}
});

test("the closed launcher skips the guest check, the page walk and the chat chunk", () => {
	const querySelector = spyOn(document, "querySelector");
	document.body.innerHTML = "<main><p>Install Ryu</p></main>";
	const container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);

	act(() => root?.render(<RyuAssistantWidget />));

	const trigger = container.querySelector<HTMLButtonElement>(
		'button[aria-label="Open Ask Ryu"]'
	);
	expect(trigger).not.toBeNull();
	expect(fetchMock).not.toHaveBeenCalled();
	expect(
		querySelector.mock.calls.some(([selector]) => selector === "main")
	).toBe(false);
	expect(assistantSessionLoadStatus()).toBe("idle");

	act(() => trigger?.focus());
	expect(assistantSessionLoadStatus()).not.toBe("idle");
	querySelector.mockRestore();
});

test("opening Ask Ryu mounts the session, which checks guest chat once", async () => {
	await loadAssistantSession();
	const container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	act(() => root?.render(<RyuAssistantWidget />));

	const trigger = container.querySelector<HTMLButtonElement>(
		'button[aria-label="Open Ask Ryu"]'
	);
	await act(async () => {
		trigger?.click();
		await Promise.resolve();
	});

	expect(container.textContent).toContain("How can I help?");
	expect(fetchMock).toHaveBeenCalledTimes(1);
});
