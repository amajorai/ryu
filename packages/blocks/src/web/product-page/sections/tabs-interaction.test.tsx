import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { DirectionProvider } from "@ryu/ui/components/direction.tsx";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { nextTabIndex, tabIds } from "./tab-keys.ts";

if (typeof document === "undefined") {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { CodeTabs } = await import("./code-tabs.tsx");
const { CopyButton } = await import("./copy-button.tsx");
const { FeatureExplorerTabs } = await import("./feature-explorer-tabs.tsx");
const { useRovingTabs } = await import("./use-roving-tabs.ts");

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
	act(() => root?.unmount());
	host?.remove();
	root = null;
	host = null;
});
afterAll(async () => {
	await GlobalRegistrator.unregister();
});

function mount(node: React.ReactNode): HTMLElement {
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	act(() => root?.render(node));
	return host;
}

function press(target: Element, key: string) {
	act(() => {
		target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
	});
}

test("tab keys wrap, jump to the ends and ignore cross-axis arrows", () => {
	expect(nextTabIndex(0, "ArrowRight", 3)).toBe(1);
	expect(nextTabIndex(2, "ArrowRight", 3)).toBe(0);
	expect(nextTabIndex(0, "ArrowLeft", 3)).toBe(2);
	expect(nextTabIndex(1, "Home", 3)).toBe(0);
	expect(nextTabIndex(1, "End", 3)).toBe(2);
	expect(nextTabIndex(0, "ArrowDown", 3)).toBeNull();
	expect(nextTabIndex(0, "ArrowDown", 3, "vertical")).toBe(1);
	expect(nextTabIndex(0, "ArrowRight", 3, "vertical")).toBeNull();
	expect(nextTabIndex(0, "ArrowDown", 3, "both")).toBe(1);
	expect(nextTabIndex(0, "ArrowLeft", 3, "both")).toBe(2);
	expect(nextTabIndex(0, "Enter", 3)).toBeNull();
	expect(nextTabIndex(0, "ArrowRight", 0)).toBeNull();
	expect(tabIds("box code", "ts")).toEqual({
		tab: "box-code-ts-tab",
		panel: "box-code-ts-panel",
	});
});

test("horizontal tab keys follow the reading direction under RTL", () => {
	expect(nextTabIndex(0, "ArrowLeft", 3, "horizontal", "rtl")).toBe(1);
	expect(nextTabIndex(0, "ArrowRight", 3, "horizontal", "rtl")).toBe(2);
	expect(nextTabIndex(0, "ArrowLeft", 3, "both", "rtl")).toBe(1);
	expect(nextTabIndex(0, "ArrowDown", 3, "both", "rtl")).toBe(1);
	expect(nextTabIndex(0, "ArrowUp", 3, "vertical", "rtl")).toBe(2);
	expect(nextTabIndex(0, "ArrowLeft", 3, "vertical", "rtl")).toBeNull();
});

test("code tabs move to the next tab with ArrowLeft under RTL", () => {
	const view = mount(
		<DirectionProvider direction="rtl">
			<CodeTabs groupId="r" samples={SAMPLES} />
		</DirectionProvider>
	);
	const tabA = view.querySelector("#r-a-tab") as HTMLElement;
	const tabB = view.querySelector("#r-b-tab") as HTMLElement;
	press(tabA, "ArrowLeft");
	expect(tabB.getAttribute("aria-selected")).toBe("true");
	expect(document.activeElement).toBe(tabB);
});

test("roving tabs: only the selected tab is focusable", () => {
	function Probe() {
		const { selected, onKeyDown, registerTab } = useRovingTabs(2, "horizontal");
		return (
			<div onKeyDown={onKeyDown} role="tablist">
				{[0, 1].map((index) => (
					<button
						aria-selected={index === selected}
						key={index}
						ref={registerTab(index)}
						role="tab"
						tabIndex={index === selected ? 0 : -1}
						type="button"
					>
						{index}
					</button>
				))}
			</div>
		);
	}
	const view = mount(<Probe />);
	const tabs = view.querySelectorAll('[role="tab"]');
	press(tabs[0] as Element, "End");
	expect(tabs[1]?.getAttribute("aria-selected")).toBe("true");
	expect(tabs[1]?.getAttribute("tabindex")).toBe("0");
	expect(document.activeElement).toBe(tabs[1] as Element);
});

const SAMPLES = [
	{ id: "a", label: "Shell", language: "bash", code: "echo a" },
	{ id: "b", label: "TypeScript", language: "ts", code: "run('b')" },
] as const;

test("code tabs switch panels with arrow keys and clicks", () => {
	const view = mount(<CodeTabs groupId="t" samples={SAMPLES} />);
	const panelA = view.querySelector("#t-a-panel") as HTMLElement;
	const panelB = view.querySelector("#t-b-panel") as HTMLElement;
	const tabA = view.querySelector("#t-a-tab") as HTMLElement;
	const tabB = view.querySelector("#t-b-tab") as HTMLElement;
	expect(panelA.hidden).toBe(false);
	expect(panelB.hidden).toBe(true);

	press(tabA, "ArrowRight");
	expect(panelA.hidden).toBe(true);
	expect(panelB.hidden).toBe(false);
	expect(tabB.getAttribute("aria-selected")).toBe("true");
	expect(document.activeElement).toBe(tabB);

	act(() => tabA.click());
	expect(panelA.hidden).toBe(false);
	expect(tabA.getAttribute("tabindex")).toBe("0");
	expect(tabB.getAttribute("tabindex")).toBe("-1");
});

test("explorer tabs move with vertical arrows too", () => {
	const view = mount(
		<FeatureExplorerTabs
			groupId="e"
			panels={[<p key="1">One</p>, <p key="2">Two</p>, <p key="3">Three</p>]}
			tabs={[
				{ id: "1", label: "Overview" },
				{ id: "2", label: "Second" },
				{ id: "3", label: "Third" },
			]}
		/>
	);
	const first = view.querySelector("#e-1-tab") as HTMLElement;
	press(first, "ArrowUp");
	expect((view.querySelector("#e-3-panel") as HTMLElement).hidden).toBe(false);
	expect((view.querySelector("#e-1-panel") as HTMLElement).hidden).toBe(true);
});

function stubColumnQuery(matches: boolean): () => void {
	const original = window.matchMedia;
	Object.defineProperty(window, "matchMedia", {
		configurable: true,
		value: (query: string) => ({
			matches,
			media: query,
			addEventListener: () => undefined,
			removeEventListener: () => undefined,
		}),
	});
	return () =>
		Object.defineProperty(window, "matchMedia", {
			configurable: true,
			value: original,
		});
}

test("explorer tab list announces the orientation it is laid out in", () => {
	const tabs = [
		{ id: "1", label: "Overview" },
		{ id: "2", label: "Second" },
	];
	const panels = [<p key="1">One</p>, <p key="2">Two</p>];
	for (const [matches, orientation] of [
		[false, "horizontal"],
		[true, "vertical"],
	] as const) {
		const restore = stubColumnQuery(matches);
		const view = mount(
			<FeatureExplorerTabs groupId="o" panels={panels} tabs={tabs} />
		);
		const list = view.querySelector('[role="tablist"]') as HTMLElement;
		expect(list.getAttribute("aria-orientation")).toBe(orientation);
		expect(view.querySelector("#o-1-tab")?.textContent).toContain("Overview");
		act(() => root?.unmount());
		root = null;
		restore();
	}
});

test("copy button writes the text and confirms in words", async () => {
	const written: string[] = [];
	Object.defineProperty(navigator, "clipboard", {
		configurable: true,
		value: {
			writeText: (text: string) => {
				written.push(text);
				return Promise.resolve();
			},
		},
	});
	const view = mount(<CopyButton text="ryu init" />);
	const button = view.querySelector("button") as HTMLButtonElement;
	expect(button.textContent).toContain("Copy");
	await act(async () => {
		button.click();
		await Promise.resolve();
	});
	expect(written).toEqual(["ryu init"]);
	expect(button.hasAttribute("data-copied")).toBe(true);
	expect(button.textContent).toContain("Copied");
	// Named once ("Copied", not "Copied Copied"); the status is announced beside it.
	expect(button.textContent?.trim()).toBe("Copied");
	expect(view.querySelector("[data-copy-status]")?.textContent).toBe("Copied");
});

test("copy button stays usable when the clipboard refuses", async () => {
	Object.defineProperty(navigator, "clipboard", {
		configurable: true,
		value: { writeText: () => Promise.reject(new Error("denied")) },
	});
	const view = mount(<CopyButton text="x" />);
	const button = view.querySelector("button") as HTMLButtonElement;
	await act(async () => {
		button.click();
		await Promise.resolve();
	});
	expect(button.hasAttribute("data-copied")).toBe(false);
});
