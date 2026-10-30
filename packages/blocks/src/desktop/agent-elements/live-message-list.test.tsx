import { afterAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { UIMessage } from "ai";
import { act } from "react";
import { createRoot } from "react-dom/client";

// Suites share one process: release the DOM so later files see their own globals.
const registeredDom = globalThis.document === undefined;
if (registeredDom) {
	GlobalRegistrator.register();
}
afterAll(async () => {
	if (registeredDom) {
		await GlobalRegistrator.unregister();
	}
});

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
Reflect.set(Element.prototype, "getAnimations", () => []);

const { LiveMessageList } = await import("./live-message-list.tsx");

const user: UIMessage = {
	id: "user-1",
	parts: [{ text: "Question?", type: "text" }],
	role: "user",
};
const reply = (text: string): UIMessage => ({
	id: "assistant-1",
	parts: [{ state: "streaming", text, type: "text" }],
	role: "assistant",
});

test("renders the live source between surface renders, else the surface's messages", async () => {
	let live: UIMessage[] | null = null;
	const listeners = new Set<() => void>();
	const source = {
		getSnapshot: () => live,
		subscribe: (listener: () => void) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	};
	const emit = async (next: UIMessage[] | null) => {
		live = next;
		await act(async () => {
			for (const listener of listeners) {
				listener();
			}
		});
	};
	// The surface appends its extras (here a marker message) to live messages too.
	const withTranscriptExtras = (messages: UIMessage[]) => [
		...messages,
		{
			id: "extra",
			parts: [{ text: "Extra row", type: "text" as const }],
			role: "assistant" as const,
		},
	];
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	await act(async () => {
		root.render(
			<LiveMessageList
				liveMessages={source}
				messages={[user, reply("Page text")]}
				status="streaming"
				withTranscriptExtras={withTranscriptExtras}
			/>
		);
	});
	expect(container.textContent).toContain("Page text");
	expect(container.textContent).not.toContain("Extra row");

	await emit([user, reply("Live text grows")]);
	expect(container.textContent).toContain("Live text grows");
	expect(container.textContent).toContain("Extra row");
	expect(container.textContent).not.toContain("Page text");

	await emit(null);
	expect(container.textContent).toContain("Page text");
	expect(container.textContent).not.toContain("Live text grows");
	await act(async () => root.unmount());
	container.remove();
});
