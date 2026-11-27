import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ReactNode } from "react";
import type { Root } from "react-dom/client";
import type { UsageRailSource } from "@/src/lib/usage-rail/usage-rail-sources.ts";
import type { SidebarUsageRail } from "./SidebarUsageRail.tsx";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

// What a user sees of the usage rings in the full sidebar: which rings show in
// the row above the account footer, what each is called, the card that opens
// on hover and on keyboard focus, and the one ring a short sidebar keeps beside
// the account button. Where the rings go as the sidebar changes its height is
// in SidebarUsageRail.placement.test.tsx.

// React DOM and Base UI read the DOM globals at import, so load them only
// after the globals above exist.
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { I18nProvider } = await import("@ryu/i18n/react");
const { SidebarUsageFooterRing, SidebarUsageRow } = await import(
	"./SidebarUsageRail.tsx"
);

const FIVE_HOURS = 5 * 3600;
const RESET = "2026-11-26T09:30:00.000Z";
/** The row: 16 pixels of padding and 40 pixels a ring. */
const ROW_PADDING = 16;
const RING_SLOT = 40;
/** The card waits 250 ms before it opens and 75 ms before it closes. */
const CARD_OPENS_MS = 350;
const CARD_CLOSES_MS = 200;

// happy-dom lays nothing out, so the width the row measures is given here.
const size = { rowWidth: 1200 };
Object.defineProperty(HTMLElement.prototype, "clientWidth", {
	configurable: true,
	get(this: HTMLElement) {
		return this.dataset.testid === "sidebar-usage-row" ? size.rowWidth : 0;
	},
});

function wait(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

let mounted: { host: HTMLElement; root: Root } | null = null;

beforeEach(() => {
	size.rowWidth = 1200;
});

afterEach(async () => {
	if (mounted) {
		const { host, root } = mounted;
		await act(() => root.unmount());
		host.remove();
		mounted = null;
	}
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

function rail(overrides: Partial<SidebarUsageRail> = {}): SidebarUsageRail {
	return {
		mode: "remaining",
		openUsage: () => undefined,
		placement: "row",
		sources: FIVE_SOURCES,
		...overrides,
	};
}

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

async function focusRing(ring: HTMLElement) {
	await act(async () => {
		ring.focus();
		await wait(CARD_OPENS_MS);
	});
}

async function hoverRing(ring: HTMLElement) {
	await act(async () => {
		ring.dispatchEvent(new MouseEvent("mouseenter"));
		await wait(CARD_OPENS_MS);
	});
}

describe("the row of rings above the account footer", () => {
	test("is a list named Usage with one ring per source, in their order", async () => {
		const host = await render(<SidebarUsageRow rail={rail()} />);
		const list = host.querySelector("ul");
		expect(list?.getAttribute("aria-label")).toBe("Usage");
		expect(list?.querySelectorAll("li")).toHaveLength(5);
		expect(ringNames(host)).toEqual([
			"Usage of Claude: 5h: 40% left",
			"Usage of Codex: 5h: 80% left",
			"Usage of Gemini: 5h: 10% left",
			"Usage of Kimi: 5h: 0% left and 1 account limited",
			"Usage of Team: 5h: 60% left",
		]);
		expect(host.querySelector('[data-testid="usage-ring-more"]')).toBeNull();
	});

	test("each ring draws its mark and an arc as long as what is left", async () => {
		const host = await render(
			<SidebarUsageRow rail={rail({ sources: [source("Claude", 40)] })} />
		);
		const ring = ringNamed(host, "Usage of Claude: 5h: 40% left");
		expect(ring.type).toBe("button");
		expect(ring.textContent).toBe("C");
		const arc = ring.querySelector('[data-testid="usage-ring-arc"]');
		expect(arc?.getAttribute("stroke-dasharray")).toBe("40 100");
		// The drawing is decoration: the name of the button carries the numbers.
		expect(ring.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
	});

	test("the names read as used when the preference says so", async () => {
		const host = await render(
			<SidebarUsageRow
				rail={rail({ mode: "used", sources: [source("Claude", 40)] })}
			/>
		);
		expect(ringNames(host)).toEqual(["Usage of Claude: 5h: 60% used"]);
	});

	test("a narrow row keeps the rings with the least left and puts the rest behind +N", async () => {
		size.rowWidth = ROW_PADDING + 3 * RING_SLOT;
		const host = await render(<SidebarUsageRow rail={rail()} />);
		expect(ringNames(host)).toEqual([
			"Usage of Gemini: 5h: 10% left",
			"Usage of Kimi: 5h: 0% left and 1 account limited",
			"Usage of 3 more sources",
		]);
		const more = host.querySelector('[data-testid="usage-ring-more"]');
		expect(more?.textContent).toBe("+3");
	});

	test("a row with room for one ring shows the +N ring for every source", async () => {
		size.rowWidth = ROW_PADDING + RING_SLOT;
		const host = await render(<SidebarUsageRow rail={rail()} />);
		expect(ringNames(host)).toEqual(["Usage of 5 sources"]);
		expect(host.querySelector("button")?.textContent).toBe("+5");
	});

	test("one source keeps its own ring in the narrowest row", async () => {
		size.rowWidth = 0;
		const host = await render(
			<SidebarUsageRow rail={rail({ sources: [source("Claude", 40)] })} />
		);
		expect(ringNames(host)).toEqual(["Usage of Claude: 5h: 40% left"]);
	});

	test("shows nothing when the rings sit beside the account button or are off", async () => {
		const footer = await render(
			<SidebarUsageRow rail={rail({ placement: "footer" })} />
		);
		expect(footer.innerHTML).toBe("");
		const none = await render(
			<SidebarUsageRow rail={rail({ placement: "none", sources: [] })} />
		);
		expect(none.innerHTML).toBe("");
	});

	test("a click on a ring, and on the +N ring, opens the Usage page", async () => {
		size.rowWidth = ROW_PADDING + 3 * RING_SLOT;
		let opened = 0;
		const host = await render(
			<SidebarUsageRow
				rail={rail({
					openUsage: () => {
						opened += 1;
					},
				})}
			/>
		);
		await act(() => ringNamed(host, "Usage of Gemini: 5h: 10% left").click());
		expect(opened).toBe(1);
		await act(() => ringNamed(host, "Usage of 3 more sources").click());
		expect(opened).toBe(2);
	});
});

describe("the card of a ring in the row", () => {
	test("is closed until a ring is hovered or focused", async () => {
		const host = await render(<SidebarUsageRow rail={rail()} />);
		expect(openCard()).toBeNull();
		for (const ring of host.querySelectorAll("button")) {
			expect(ring.hasAttribute("data-popup-open")).toBe(false);
		}
	});

	test("keyboard focus opens it with the accounts, and the focus stays on the ring", async () => {
		const host = await render(<SidebarUsageRow rail={rail()} />);
		const ring = ringNamed(host, "Usage of Claude: 5h: 40% left");
		await focusRing(ring);
		const card = openCard();
		expect(card).not.toBeNull();
		expect(ring.hasAttribute("data-popup-open")).toBe(true);
		expect(card?.textContent).toContain("Claude");
		expect(card?.textContent).toContain("Accounts outside every pool");
		expect(card?.textContent).toContain("claude@example.test");
		expect(card?.textContent).toContain("5h: 40% left");
		expect(card?.textContent).toContain(
			"Select the ring to open the Usage page."
		);
		expect(card?.querySelectorAll("section")).toHaveLength(1);
		// A hover card never takes the focus: Tab goes on to the next ring.
		expect(document.activeElement).toBe(ring);
	});

	test("Escape closes it", async () => {
		const host = await render(<SidebarUsageRow rail={rail()} />);
		const ring = ringNamed(host, "Usage of Claude: 5h: 40% left");
		await focusRing(ring);
		expect(openCard()).not.toBeNull();
		await act(async () => {
			ring.dispatchEvent(
				new KeyboardEvent("keydown", { bubbles: true, key: "Escape" })
			);
			await wait(CARD_CLOSES_MS);
		});
		expect(openCard()).toBeNull();
		expect(ring.hasAttribute("data-popup-open")).toBe(false);
	});

	test("moving the focus away closes it", async () => {
		const host = await render(<SidebarUsageRow rail={rail()} />);
		const ring = ringNamed(host, "Usage of Claude: 5h: 40% left");
		await focusRing(ring);
		expect(openCard()).not.toBeNull();
		await act(async () => {
			ring.blur();
			await wait(CARD_CLOSES_MS);
		});
		expect(openCard()).toBeNull();
	});

	test("the pointer opens it after a moment and closes it on the way out", async () => {
		const host = await render(<SidebarUsageRow rail={rail()} />);
		const ring = ringNamed(host, "Usage of Team: 5h: 60% left");
		await act(async () => {
			ring.dispatchEvent(new MouseEvent("mouseenter"));
			await wait(50);
		});
		// A pointer that only crosses the row opens no card.
		expect(openCard()).toBeNull();
		await act(() => wait(CARD_OPENS_MS));
		expect(openCard()?.textContent).toContain("team@example.test");
		await act(async () => {
			ring.dispatchEvent(new MouseEvent("mouseleave"));
			await wait(CARD_CLOSES_MS);
		});
		expect(openCard()).toBeNull();
	});

	test("a used-up account is marked in words, not by colour alone", async () => {
		const host = await render(<SidebarUsageRow rail={rail()} />);
		await focusRing(
			ringNamed(host, "Usage of Kimi: 5h: 0% left and 1 account limited")
		);
		const card = openCard();
		expect(card?.textContent).toContain("Limited until ");
		expect(
			card?.querySelectorAll('[data-testid="usage-rail-account"][data-limited]')
		).toHaveLength(1);
	});

	test("the card of the +N ring lists every source behind it", async () => {
		size.rowWidth = ROW_PADDING + 3 * RING_SLOT;
		const host = await render(<SidebarUsageRow rail={rail()} />);
		await hoverRing(ringNamed(host, "Usage of 3 more sources"));
		const card = openCard();
		expect(card?.querySelectorAll("section")).toHaveLength(3);
		expect(card?.textContent).toContain("claude@example.test");
		expect(card?.textContent).toContain("codex@example.test");
		expect(card?.textContent).toContain("team@example.test");
		// The two rings that kept their place have their own cards.
		expect(card?.textContent).not.toContain("gemini@example.test");
		expect(card?.textContent).not.toContain("kimi@example.test");
	});
});

describe("the one ring beside the account button of a short sidebar", () => {
	test("stands for every source, and its card lists them all", async () => {
		const host = await render(
			<SidebarUsageFooterRing rail={rail({ placement: "footer" })} />
		);
		expect(ringNames(host)).toEqual(["Usage of 5 sources"]);
		expect(host.querySelector("button")?.textContent).toBe("+5");
		expect(openCard()).toBeNull();
		await focusRing(ringNamed(host, "Usage of 5 sources"));
		const card = openCard();
		expect(card?.querySelectorAll("section")).toHaveLength(5);
		for (const entry of FIVE_SOURCES) {
			expect(card?.textContent).toContain(entry.name);
		}
		expect(card?.textContent).toContain("Limited until ");
	});

	test("a single source keeps its own ring, never a +1 ring", async () => {
		const host = await render(
			<SidebarUsageFooterRing
				rail={rail({ placement: "footer", sources: [source("Claude", 40)] })}
			/>
		);
		expect(ringNames(host)).toEqual(["Usage of Claude: 5h: 40% left"]);
		expect(host.querySelector('[data-testid="usage-ring-more"]')).toBeNull();
	});

	test("a click opens the Usage page", async () => {
		let opened = 0;
		const host = await render(
			<SidebarUsageFooterRing
				rail={rail({
					openUsage: () => {
						opened += 1;
					},
					placement: "footer",
				})}
			/>
		);
		await act(() => ringNamed(host, "Usage of 5 sources").click());
		expect(opened).toBe(1);
	});

	test("shows nothing while the row shows, and nothing with the rings off", async () => {
		const row = await render(<SidebarUsageFooterRing rail={rail()} />);
		expect(row.innerHTML).toBe("");
		const none = await render(
			<SidebarUsageFooterRing rail={rail({ placement: "none", sources: [] })} />
		);
		expect(none.innerHTML).toBe("");
	});
});
