import { afterAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";

GlobalRegistrator.register();
Object.defineProperty(navigator, "userAgent", {
	value: "Macintosh",
	configurable: true,
});
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

// happy-dom currently delivers only the first MutationObserver batch for a
// document. Use a small spec-shaped test double so repeated style mutations
// exercise the component's observer contract just as they do in a browser.
const NativeMutationObserver = globalThis.MutationObserver;
class TestMutationObserver implements MutationObserver {
	private static readonly instances = new Set<TestMutationObserver>();
	private target: Node | null = null;
	private options: MutationObserverInit | null = null;
	private connected = false;

	constructor(private readonly callback: MutationCallback) {}

	observe(target: Node, options?: MutationObserverInit) {
		this.target = target;
		this.options = options ?? null;
		this.connected = true;
		TestMutationObserver.instances.add(this);
	}

	disconnect() {
		this.connected = false;
		TestMutationObserver.instances.delete(this);
		this.target = null;
		this.options = null;
	}

	takeRecords(): MutationRecord[] {
		return [];
	}

	static notify(target: Node, attributeName: string) {
		for (const observer of TestMutationObserver.instances) {
			if (
				!observer.connected ||
				observer.target !== target ||
				!observer.options?.attributeFilter?.includes(attributeName)
			) {
				continue;
			}
			queueMicrotask(() => {
				if (!observer.connected) {
					return;
				}
				const record = {
					type: "attributes",
					target,
					attributeName,
					attributeNamespace: null,
					oldValue: null,
					addedNodes: document.createDocumentFragment().childNodes,
					removedNodes: document.createDocumentFragment().childNodes,
					previousSibling: null,
					nextSibling: null,
				} satisfies MutationRecord;
				observer.callback([record], observer);
			});
		}
	}
}
globalThis.MutationObserver = TestMutationObserver;
const rootSetAttribute = document.documentElement.setAttribute.bind(
	document.documentElement
);
document.documentElement.setAttribute = (name: string, value: string) => {
	rootSetAttribute(name, value);
	TestMutationObserver.notify(document.documentElement, name);
};
let maximized = false;
let resize = () => {};
const calls: number[] = [];
mock.module("@tauri-apps/api/webviewWindow", () => ({
	getCurrentWebviewWindow: () => ({
		isMaximized: async () => maximized,
		isFullscreen: async () => false,
		onResized: async (callback: () => void) => {
			resize = callback;
			return () => {};
		},
	}),
}));
mock.module("@/src/lib/tauri-ready.ts", () => ({
	isTauriReady: () => true,
	invokeWhenReady: async (_command: string, args: { radius: number }) => {
		calls.push(args.radius);
	},
}));
const { PageWrapper } = await import("./PageWrapper.tsx");
const originalStyle = globalThis.getComputedStyle;
let corner = "32px";
globalThis.getComputedStyle = (element: Element) => {
	const style = document.createElement("div").style;
	style.borderTopLeftRadius = element.classList.contains("rounded-none")
		? "0px"
		: corner;
	style.zoom = "1";
	return style;
};
afterAll(() => {
	globalThis.getComputedStyle = originalStyle;
	document.documentElement.setAttribute = rootSetAttribute;
	globalThis.MutationObserver = NativeMutationObserver;
	GlobalRegistrator.unregister();
});

test("native backdrop tracks roundness, maximization and restoration without duplicate updates", async () => {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	await act(async () => {
		root.render(<PageWrapper>Content</PageWrapper>);
	});
	expect(calls.at(-1)).toBe(32);
	const initialCount = calls.length;
	await act(async () => {
		document.documentElement.setAttribute("style", "--unrelated: 1");
		await new Promise((resolve) => setTimeout(resolve, 20));
	});
	expect(calls.length).toBe(initialCount);
	corner = "48px";
	await act(async () => {
		document.documentElement.setAttribute("style", "--radius: 1");
		await new Promise((resolve) => setTimeout(resolve, 20));
	});
	expect(calls.at(-1)).toBe(48);
	maximized = true;
	await act(async () => {
		resize();
	});
	expect(calls.at(-1)).toBe(0);
	maximized = false;
	await act(async () => {
		resize();
	});
	expect(calls.at(-1)).toBe(48);
	await act(async () => {
		root.unmount();
	});
	const finalCount = calls.length;
	document.documentElement.setAttribute("style", "--radius: 2");
	await new Promise((resolve) => setTimeout(resolve, 20));
	expect(calls.length).toBe(finalCount);
	container.remove();
});
