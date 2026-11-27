import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { ReactNode } from "react";
import type { Root } from "react-dom/client";
import type { UsageRailSource } from "@/src/lib/usage-rail/usage-rail-sources.ts";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

// Where the full sidebar shows its usage rings as its height changes: the row
// above the account footer, the one ring beside the account button when the
// row would squeeze the chat list, and nothing at all with no source of usage.
// The rings and their cards are in SidebarUsageRail.test.tsx.

// The sources come from Core through the data hook, which has its own test.
// Bun's module mocks are process-wide and this file runs in its own process.
let railSources: UsageRailSource[] = [];
mock.module("@/src/hooks/useUsageRailSources.ts", () => ({
	useUsageRailSources: () => railSources,
}));

// React DOM and Base UI read the DOM globals at import, so load them only
// after the globals above exist.
const { act, useRef } = await import("react");
const { createRoot } = await import("react-dom/client");
const { I18nProvider } = await import("@ryu/i18n/react");
const { resetUsageBarPrefs, setUsageBarPrefs } = await import(
	"@/src/hooks/useUsageBarPrefs.ts"
);
const { useSettingsDialog } = await import("@/src/store/useSettingsDialog.ts");
const { SidebarUsageFooterRing, SidebarUsageRow, useSidebarUsageRail } =
	await import("./SidebarUsageRail.tsx");

const FIVE_HOURS = 5 * 3600;
const RESET = "2026-11-26T09:30:00.000Z";
/** The row is 44 pixels high and the chat list keeps 240. */
const ROW_HEIGHT = 44;
const MIN_LIST_HEIGHT = 240;
/** The card waits 250 ms before it opens. */
const CARD_OPENS_MS = 350;

// happy-dom lays nothing out, so the two sizes the rail measures are given
// here: a row wide enough for every ring, and the height of the chat list,
// which loses the row's height while the row shows.
const size = { sidebarHeight: 900 };
Object.defineProperty(HTMLElement.prototype, "clientWidth", {
	configurable: true,
	get(this: HTMLElement) {
		return this.dataset.testid === "sidebar-usage-row" ? 1200 : 0;
	},
});
Object.defineProperty(HTMLElement.prototype, "clientHeight", {
	configurable: true,
	get(this: HTMLElement) {
		if (this.dataset.testid !== "chat-list") {
			return 0;
		}
		const row = document.querySelector('[data-testid="sidebar-usage-row"]');
		return size.sidebarHeight - (row ? ROW_HEIGHT : 0);
	},
});

/** A ResizeObserver the test fires by hand for one element. */
class ManualResizeObserver {
	static live = new Set<ManualResizeObserver>();
	readonly targets = new Set<Element>();
	private readonly notify: (entries: unknown[]) => void;

	constructor(notify: (entries: unknown[]) => void) {
		this.notify = notify;
		ManualResizeObserver.live.add(this);
	}

	observe(target: Element) {
		this.targets.add(target);
	}

	unobserve(target: Element) {
		this.targets.delete(target);
	}

	disconnect() {
		ManualResizeObserver.live.delete(this);
	}

	static resized(target: Element) {
		for (const observer of ManualResizeObserver.live) {
			if (observer.targets.has(target)) {
				observer.notify([]);
			}
		}
	}
}
const realResizeObserver = globalThis.ResizeObserver;

function setResizeObserver(value: unknown) {
	Object.defineProperty(globalThis, "ResizeObserver", {
		configurable: true,
		value,
		writable: true,
	});
}

function wait(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

let mounted: { host: HTMLElement; root: Root } | null = null;

beforeEach(() => {
	size.sidebarHeight = 900;
	ManualResizeObserver.live.clear();
	setResizeObserver(ManualResizeObserver);
});

afterEach(async () => {
	if (mounted) {
		const { host, root } = mounted;
		await act(() => root.unmount());
		host.remove();
		mounted = null;
	}
	railSources = [];
	setResizeObserver(realResizeObserver);
	act(() => resetUsageBarPrefs());
	localStorage.clear();
	useSettingsDialog.setState({ open: false, section: "general" });
});

async function render(node: ReactNode) {
	if (!mounted) {
		const host = document.createElement("div");
		document.body.append(host);
		mounted = { host, root: createRoot(host) };
	}
	const { host, root } = mounted;
	await act(async () => {
		root.render(
			<I18nProvider
				autoLocalizeDom={false}
				initialLocale="en"
				initialPackId={null}
			>
				{node}
			</I18nProvider>
		);
	});
	return host;
}

/** One sign-in with `left` percent left in its five hour window. */
function source(name: string, left: number): UsageRailSource {
	const limited = left === 0;
	return {
		accounts: [
			{
				active: true,
				id: `${name}-account`,
				label: `${name.toLowerCase()}@example.test`,
				leftPercent: left,
				limited,
				limitedUntil: limited ? RESET : null,
				state: "ok",
				windows: [
					{
						key: `5h-${name}`,
						label: "5h",
						model: null,
						resetsAt: RESET,
						usedPercent: 100 - left,
						windowSeconds: FIVE_HOURS,
					},
				],
			},
		],
		id: `provider:${name}`,
		kind: "provider",
		leftPercent: left,
		logo: { kind: "initial", text: name.slice(0, 1) },
		name,
		readable: 1,
		tracks: [{ label: "5h", usedPercent: 100 - left }],
	};
}

const FIVE_SOURCES = [
	source("Claude", 40),
	source("Codex", 80),
	source("Gemini", 10),
	source("Kimi", 0),
	source("Team", 60),
];

/** The accessible names of the rings inside `scope`, in the order they show. */
function ringNames(scope: Element): string[] {
	return [...scope.querySelectorAll("button")].map(
		(button) => button.getAttribute("aria-label") ?? ""
	);
}

function ringNamed(scope: Element, name: string): HTMLButtonElement {
	const ring = [...scope.querySelectorAll("button")].find(
		(button) => button.getAttribute("aria-label") === name
	);
	if (!ring) {
		throw new Error(`No ring is named "${name}".`);
	}
	return ring;
}

/** The open card. The app shows one at a time. */
function openCard(): HTMLElement | null {
	return document.querySelector<HTMLElement>(
		'[data-slot="hover-card-content"]'
	);
}

async function hoverRing(ring: HTMLElement) {
	await act(async () => {
		ring.dispatchEvent(new MouseEvent("mouseenter"));
		await wait(CARD_OPENS_MS);
	});
}

describe("the sidebar as a whole", () => {
	/** The parts of the sidebar the rings live between, as AppSidebar lays them out. */
	function Sidebar() {
		const listRef = useRef<HTMLDivElement | null>(null);
		const usageRail = useSidebarUsageRail(listRef);
		return (
			<aside>
				<div data-testid="chat-list" ref={listRef} />
				<div data-testid="above-footer">
					<SidebarUsageRow rail={usageRail} />
				</div>
				<footer data-testid="account-footer">
					<SidebarUsageFooterRing rail={usageRail} />
				</footer>
			</aside>
		);
	}

	function part(host: Element, name: "above-footer" | "account-footer") {
		const element = host.querySelector(`[data-testid="${name}"]`);
		if (!element) {
			throw new Error(`The sidebar has no ${name}.`);
		}
		return element;
	}

	async function resizeSidebar(host: Element, height: number) {
		size.sidebarHeight = height;
		const list = host.querySelector('[data-testid="chat-list"]');
		if (!list) {
			throw new Error("The sidebar has no chat list.");
		}
		await act(async () => {
			ManualResizeObserver.resized(list);
			// The measure waits for the next frame.
			await wait(60);
		});
	}

	test("with no source of usage it shows no ring, no row and no placeholder", async () => {
		railSources = [];
		const host = await render(<Sidebar />);
		expect(host.querySelectorAll("button")).toHaveLength(0);
		expect(part(host, "above-footer").innerHTML).toBe("");
		expect(part(host, "account-footer").innerHTML).toBe("");
		expect(host.querySelector('[aria-label="Usage"]')).toBeNull();
	});

	test("a tall sidebar shows the row and nothing beside the account button", async () => {
		railSources = FIVE_SOURCES;
		const host = await render(<Sidebar />);
		expect(ringNames(part(host, "above-footer"))).toHaveLength(5);
		expect(part(host, "account-footer").innerHTML).toBe("");
	});

	test("the names follow the preference: used first, left once the user asks", async () => {
		railSources = [source("Claude", 40)];
		const host = await render(<Sidebar />);
		expect(ringNames(host)).toEqual(["Usage of Claude: 5h: 60% used"]);
		await act(() => setUsageBarPrefs({ mode: "remaining" }));
		expect(ringNames(host)).toEqual(["Usage of Claude: 5h: 40% left"]);
	});

	test("a sidebar too short for the row collapses to the +N ring with its popover", async () => {
		railSources = FIVE_SOURCES;
		size.sidebarHeight = MIN_LIST_HEIGHT + ROW_HEIGHT - 1;
		const host = await render(<Sidebar />);
		expect(part(host, "above-footer").innerHTML).toBe("");
		const footer = part(host, "account-footer");
		expect(ringNames(footer)).toEqual(["Usage of 5 sources"]);
		await hoverRing(ringNamed(footer, "Usage of 5 sources"));
		expect(openCard()?.querySelectorAll("section")).toHaveLength(5);
	});

	test("the row stays while the chat list keeps its minimum height, to the pixel", async () => {
		railSources = FIVE_SOURCES;
		size.sidebarHeight = MIN_LIST_HEIGHT + ROW_HEIGHT;
		const host = await render(<Sidebar />);
		expect(ringNames(part(host, "above-footer"))).toHaveLength(5);
		expect(part(host, "account-footer").innerHTML).toBe("");
	});

	test("shrinking the window collapses the row and growing it brings the row back", async () => {
		railSources = FIVE_SOURCES;
		const host = await render(<Sidebar />);
		expect(ringNames(part(host, "above-footer"))).toHaveLength(5);

		await resizeSidebar(host, 200);
		expect(part(host, "above-footer").innerHTML).toBe("");
		expect(ringNames(part(host, "account-footer"))).toEqual([
			"Usage of 5 sources",
		]);
		// The list is taller without the row. Measured again, the ring stays put.
		await resizeSidebar(host, 200);
		expect(part(host, "above-footer").innerHTML).toBe("");

		await resizeSidebar(host, 900);
		expect(ringNames(part(host, "above-footer"))).toHaveLength(5);
		expect(part(host, "account-footer").innerHTML).toBe("");
	});

	test("the rings appear when the first reading arrives", async () => {
		railSources = [];
		const host = await render(<Sidebar />);
		expect(host.querySelectorAll("button")).toHaveLength(0);
		railSources = [source("Claude", 40), source("Codex", 80)];
		await render(<Sidebar />);
		expect(ringNames(part(host, "above-footer"))).toEqual([
			"Usage of Claude: 5h: 60% used",
			"Usage of Codex: 5h: 20% used",
		]);
	});

	test("a click on a ring opens Settings on the Usage page", async () => {
		railSources = [source("Claude", 40)];
		const host = await render(<Sidebar />);
		expect(useSettingsDialog.getState().open).toBe(false);
		await act(() => ringNamed(host, "Usage of Claude: 5h: 60% used").click());
		expect(useSettingsDialog.getState().open).toBe(true);
		expect(useSettingsDialog.getState().section).toBe("usage");
	});
});
