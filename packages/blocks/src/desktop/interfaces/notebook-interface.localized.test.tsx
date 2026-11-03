import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
	INTERFACE_PROTOCOL_VERSION,
	type InterfacePort,
	type InterfaceSnapshot,
} from "@ryuhq/protocol/interfaces";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { NotebookInterface } from "./notebook-interface.tsx";

/**
 * The DOM localizer rewrites aria-label and title in every non-English
 * locale, so the notebook's focus moves must not find elements by their
 * English labels. These tests write each label in Japanese the moment React
 * sets it, as the localizer does before the browser paints.
 */
const JA: Record<string, string> = {
	"Clear search": "検索をクリア",
	"Close sidebar": "サイドバーを閉じる",
	Notebook: "ノートブック",
	"Open sidebar": "サイドバーを開く",
};
const TRANSLATED_ATTRIBUTES = new Set(["aria-label", "title"]);

const registeredDom = globalThis.document === undefined;
if (registeredDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
afterAll(async () => {
	if (registeredDom) {
		await GlobalRegistrator.unregister();
	}
});

const nativeSetAttribute = Element.prototype.setAttribute;
const nativeRect = HTMLElement.prototype.getBoundingClientRect;
let stageWidth = 0;
beforeEach(() => {
	Element.prototype.setAttribute = function setLocalized(name, value) {
		const translated = TRANSLATED_ATTRIBUTES.has(name) ? JA[value] : undefined;
		nativeSetAttribute.call(this, name, translated ?? value);
	};
	HTMLElement.prototype.getBoundingClientRect = function measured() {
		const rect = nativeRect.call(this);
		if (stageWidth > 0 && this.dataset.testid === "interface-notebook") {
			return { ...rect.toJSON(), height: 700, width: stageWidth } as DOMRect;
		}
		return rect;
	};
});
afterEach(() => {
	Element.prototype.setAttribute = nativeSetAttribute;
	HTMLElement.prototype.getBoundingClientRect = nativeRect;
	stageWidth = 0;
});

const SNAPSHOT: InterfaceSnapshot = {
	agents: [],
	events: [],
	groups: [],
	threads: [
		{
			agentIds: [],
			id: "thread-notes",
			lastMessage: null,
			lastMessageRole: "assistant",
			messageCount: 2,
			pinned: false,
			projectId: null,
			running: false,
			teamId: null,
			title: "Release notes",
			updatedAt: "2026-10-12T11:00:00Z",
		},
	],
	version: INTERFACE_PROTOCOL_VERSION,
};

const PORT: InterfacePort = {
	closeThread: () => undefined,
	openThread: () => undefined,
	startThread: () => undefined,
};

async function mount() {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	await act(async () =>
		root.render(
			<NotebookInterface
				activeThreadId={null}
				loading={false}
				params={{}}
				port={PORT}
				snapshot={SNAPSHOT}
				threadView={null}
			/>
		)
	);
	return {
		container,
		async dispose() {
			await act(async () => root.unmount());
			container.remove();
		},
	};
}

async function frames() {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 100));
	});
}

async function pressWindow(init: KeyboardEventInit) {
	await act(async () => {
		window.dispatchEvent(new KeyboardEvent("keydown", init));
	});
}

test("under ja, Ctrl+Shift+F still focuses the notebook search field", async () => {
	const view = await mount();
	const nav = view.container.querySelector("nav[data-notebook-nav]");
	// The label really is translated, so an English selector would miss it.
	expect(nav?.getAttribute("aria-label")).toBe("ノートブック");
	await pressWindow({ ctrlKey: true, key: "F", shiftKey: true });
	await frames();
	const field = view.container.querySelector('input[type="search"]');
	expect(field).not.toBe(null);
	expect(document.activeElement).toBe(field);
	await view.dispose();
});

test("under ja, closing the sidebar drawer returns focus to Open sidebar", async () => {
	stageWidth = 600;
	const view = await mount();
	await frames();
	const open = () =>
		view.container.querySelector<HTMLButtonElement>(
			'header button[aria-keyshortcuts="Control+\\\\"]'
		);
	expect(open()?.getAttribute("aria-label")).toBe("サイドバーを開く");
	await act(async () => open()?.click());
	await frames();
	const scrim = [...view.container.querySelectorAll("button")].find(
		(button) => button.getAttribute("aria-label") === "サイドバーを閉じる"
	);
	expect(scrim).toBeDefined();
	await act(async () => scrim?.click());
	await frames();
	const button = open();
	expect(button).not.toBe(null);
	expect(document.activeElement).toBe(button);
	await view.dispose();
});
