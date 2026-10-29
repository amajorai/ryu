import { afterAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { MentionItem } from "./types.ts";

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

const { Markdown } = await import("./markdown.tsx");

// Every render of a mention link resolves its item with `mentionItems.find`, so
// counting those calls counts renders of the finished block that holds the link.
function countingMentionItems() {
	let calls = 0;
	const items: MentionItem[] = [{ id: "notes", kind: "file", label: "notes" }];
	const find = items.find.bind(items);
	Reflect.set(items, "find", (...args: Parameters<typeof items.find>) => {
		calls++;
		return find(...args);
	});
	return { items, renders: () => calls };
}

test("streaming into the last block leaves finished blocks unrendered", async () => {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	const { items, renders } = countingMentionItems();
	const finished =
		"See [notes](#ryu-mention-file-notes) first.\n\nSecond paragraph.\n\n";
	let tail = "Streaming";

	const renderWith = async (text: string) => {
		await act(async () => {
			root.render(
				<Markdown content={finished + text} isStreaming mentionItems={items} />
			);
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
	};

	await renderWith(tail);
	const settled = renders();
	expect(settled).toBeGreaterThan(0);

	for (let chunk = 0; chunk < 30; chunk++) {
		tail += ` word${chunk}`;
		await renderWith(tail);
	}

	expect(renders()).toBe(settled);
	expect(container.textContent).toContain("word29");
	await act(async () => root.unmount());
	container.remove();
});
