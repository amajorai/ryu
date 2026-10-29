import { afterEach, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { MessageContextMenuProps } from "./message-context-menu.tsx";

if (typeof document === "undefined") {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
Reflect.set(Element.prototype, "getAnimations", () => []);
const { MessageContextMenu } = await import("./message-context-menu.tsx");

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});
afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
});

async function openMenu(props: Omit<MessageContextMenuProps, "children">) {
	await act(async () =>
		root.render(
			<MessageContextMenu {...props}>
				<p data-testid="message">Hello there</p>
			</MessageContextMenu>
		)
	);
	const message = container.querySelector('[data-testid="message"]');
	if (!message) {
		throw new Error("message body missing");
	}
	await act(async () => {
		message.dispatchEvent(
			new MouseEvent("contextmenu", {
				bubbles: true,
				cancelable: true,
				button: 2,
				clientX: 10,
				clientY: 10,
			})
		);
	});
}

function menuItem(label: string): HTMLElement {
	const item = Array.from(
		document.querySelectorAll<HTMLElement>('[role="menuitem"]')
	).find(
		(node) =>
			node.textContent?.trim() === label ||
			node.getAttribute("aria-label") === label
	);
	if (!item) {
		throw new Error(`menu item missing: ${label}`);
	}
	return item;
}

test("right-click opens reactions on top, then reply and copy", async () => {
	const toggled: string[] = [];
	let replied = 0;
	await openMenu({
		onReply: () => {
			replied += 1;
		},
		reactions: {
			buckets: [{ emoji: "🔥", count: 2, reactedByMe: true }],
			canReact: true,
			onToggle: (emoji) => toggled.push(emoji),
		},
		text: "Hello there",
	});

	const items = Array.from(
		document.querySelectorAll<HTMLElement>('[role="menuitem"]')
	);
	// The strip leads the menu, and an existing non-quick reaction is offered
	// so the user can take it back from here.
	expect(items[0]?.textContent).toBe("👍");
	expect(menuItem("Remove 🔥 reaction")).toBeDefined();
	expect(menuItem("Copy text")).toBeDefined();

	await act(async () => menuItem("Add ❤️ reaction").click());
	expect(toggled).toEqual(["❤️"]);

	await openMenu({
		onReply: () => {
			replied += 1;
		},
		text: "Hello there",
	});
	await act(async () => menuItem("Reply").click());
	expect(replied).toBe(1);
});

test("no reaction strip for a message that cannot take reactions", async () => {
	await openMenu({
		reactions: { buckets: [], canReact: false, onToggle: () => undefined },
		text: "Hello there",
	});
	expect(
		document.querySelector('[data-slot="message-context-menu-reactions"]')
	).toBeNull();
	expect(menuItem("Copy text")).toBeDefined();
});

test("renders children untouched when there is nothing to offer", async () => {
	await act(async () =>
		root.render(
			<MessageContextMenu>
				<p data-testid="message">Hello there</p>
			</MessageContextMenu>
		)
	);
	expect(
		container.querySelector('[data-slot="message-context-menu-trigger"]')
	).toBeNull();
});
