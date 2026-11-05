// Time charts keep one physical axis under dir="rtl" (oldest on the left, as
// the Video Studio and Timeline time axes do), so the plot, its hover columns
// and its axis labels agree. The Passport booklet's arrows follow the
// reading direction like its Previous/Next buttons, and the Live tile's and
// Passport pages' fallback copy goes through the catalog.
import "./board-test-dom.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { registerLiteralCatalogLoader } from "@ryu/i18n/core";
import { I18nProvider } from "@ryu/i18n/react";
import { act, type ReactElement, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { BankSpendChart } from "./bank-chart.tsx";
import { LiveTile } from "./live-tile.tsx";
import { usePassportKeys } from "./passport-interface-keys.ts";
import { BlankFace } from "./passport-page-face.tsx";
import { TickerPriceHistory } from "./ticker-chart.tsx";
import type { TickerSeries } from "./ticker-model-series.ts";

let mounted: { container: HTMLElement; root: Root } | null = null;

afterEach(() => {
	registerLiteralCatalogLoader(null);
	if (mounted) {
		const { container, root } = mounted;
		act(() => root.unmount());
		container.remove();
		mounted = null;
	}
});

function mount(element: ReactElement, direction: "ltr" | "rtl") {
	const container = document.createElement("div");
	container.setAttribute("dir", direction);
	container.style.direction = direction;
	document.body.append(container);
	const root = createRoot(container);
	act(() => root.render(element));
	mounted = { container, root };
	return container;
}

function find(container: ParentNode, selector: string): HTMLElement {
	const element = container.querySelector<HTMLElement>(selector);
	if (!element) {
		throw new Error(`missing ${selector}`);
	}
	return element;
}

/** The `dir` the nearest ancestor (or the element itself) declares. */
function declaredDir(element: Element): string | null {
	return element.closest("[dir]")?.getAttribute("dir") ?? null;
}

const DAY = 86_400_000;
const START = new Date(2026, 9, 1).getTime();

describe("bank spend chart under RTL", () => {
	const days = Array.from({ length: 5 }, (_, index) => ({
		count: index,
		date: new Date(START + index * DAY),
		key: `d${index}`,
		spent: (index + 1) * 1000,
	}));

	test("'Today' and the newest bar share the physical right", () => {
		const container = mount(
			<BankSpendChart
				currency="USD"
				days={days}
				headingId="spend"
				title="Daily spend"
			/>,
			"rtl"
		);
		const today = find(container, "[data-testid='bank-chart-today']");
		expect(today.textContent).toBe("Today");
		expect(today.className).toContain("right-0");
		expect(declaredDir(today)).toBe("ltr");
		const slider = find(container, "[role='slider']");
		const bars = slider.querySelector("[aria-hidden='true'].flex");
		if (!bars) {
			throw new Error("missing bar row");
		}
		// The bar row lays out oldest-first left to right, so today's bar is
		// the right-most one, above the "Today" label.
		expect(declaredDir(bars)).toBe("ltr");
	});

	test("ArrowLeft reads the older day, toward the left of the plot", () => {
		const container = mount(
			<BankSpendChart
				currency="USD"
				days={days}
				headingId="spend"
				title="Daily spend"
			/>,
			"rtl"
		);
		const slider = find(container, "[role='slider']");
		act(() => slider.focus());
		act(() => {
			slider.dispatchEvent(
				new KeyboardEvent("keydown", { bubbles: true, key: "ArrowLeft" })
			);
		});
		expect(slider.getAttribute("aria-valuenow")).toBe(String(days.length - 1));
	});
});

describe("ticker price chart under RTL", () => {
	const buckets = Array.from({ length: 6 }, (_, index) => ({
		close: 10 + index * 3,
		date: START + index * DAY,
		key: `b${index}`,
		messages: 3,
		threads: 1,
	}));
	const series: TickerSeries = {
		buckets,
		narrowed: false,
		opening: 8,
		unit: "day",
	};

	function renderTicker() {
		return mount(
			<TickerPriceHistory
				now={START + 5 * DAY}
				onRangeChange={() => undefined}
				price={25}
				range={7}
				series={series}
				symbol="RYU"
			/>,
			"rtl"
		);
	}

	test("the scrub line sits over the hovered column", () => {
		const container = renderTicker();
		const chart = find(container, "[data-testid='ticker-price-chart']");
		expect(chart.getAttribute("dir")).toBe("ltr");
		const strip = chart.querySelector(":scope > div.flex");
		if (!strip) {
			throw new Error("missing hover strip");
		}
		const columns = [...strip.children];
		const last = columns.length - 1;
		act(() => {
			columns[last]?.dispatchEvent(
				new PointerEvent("pointerenter", { bubbles: false })
			);
			columns[last]?.dispatchEvent(
				new PointerEvent("pointerover", { bubbles: true })
			);
		});
		const scrubLine = chart.querySelector<HTMLElement>("span.w-px");
		if (!scrubLine) {
			throw new Error("missing scrub line");
		}
		const columnX = ((last + 0.5) / columns.length) * 100;
		expect(Number.parseFloat(scrubLine.style.left)).toBeCloseTo(columnX, 5);
	});

	test("the 'Today' label shares the plot's physical axis", () => {
		const container = renderTicker();
		const now = find(container, "[data-testid='ticker-chart-now']");
		expect(now.textContent).toBe("Today");
		expect(declaredDir(now)).toBe("ltr");
	});
});

function PassportKeysProbe({ onTurn }: { onTurn: (turn: string) => void }) {
	const rootRef = useRef<HTMLDivElement | null>(null);
	usePassportKeys({
		anySheet: false,
		closePanel: () => undefined,
		goToSpread: (index) => onTurn(`spread ${index}`),
		next: () => onTurn("next"),
		panelOpen: false,
		previous: () => onTurn("previous"),
		rootRef,
		setSheet: () => undefined,
		spreads: [0, 1, 2],
		turnable: true,
	});
	return (
		<div ref={rootRef}>
			<div data-passport-booklet="" tabIndex={-1} />
		</div>
	);
}

function passportTurn(direction: "ltr" | "rtl", key: string): string[] {
	const turns: string[] = [];
	const container = mount(
		<PassportKeysProbe onTurn={(turn) => turns.push(turn)} />,
		direction
	);
	const booklet = find(container, "[data-passport-booklet]");
	act(() => {
		booklet.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key }));
	});
	return turns;
}

describe("passport booklet keys", () => {
	test("ArrowRight turns to the next page in LTR", () => {
		expect(passportTurn("ltr", "ArrowRight")).toEqual(["next"]);
	});

	test("ArrowRight turns to the previous page in RTL", () => {
		expect(passportTurn("rtl", "ArrowRight")).toEqual(["previous"]);
	});

	test("ArrowLeft turns to the next page in RTL", () => {
		expect(passportTurn("rtl", "ArrowLeft")).toEqual(["next"]);
	});
});

const DE: Record<string, string> = {
	"No streams yet": "Noch keine Streams",
	Visas: "Visa",
};

function renderInGerman(element: ReactElement) {
	registerLiteralCatalogLoader((requested) =>
		requested.startsWith("de") ? DE : {}
	);
	return mount(
		<I18nProvider initialLocale="de" initialPackId={null}>
			{element}
		</I18nProvider>,
		"ltr"
	);
}

async function settle() {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
}

describe("interface fallback copy is translated", () => {
	test("an offline Live tile's empty title uses the catalog", async () => {
		const container = renderInGerman(
			<LiveTile
				agent={null}
				category={null}
				label="Channel"
				live={false}
				now={START}
				onActivate={() => undefined}
				thread={null}
				tileId="agent-1"
			/>
		);
		await settle();
		const title = find(container, "button[title]");
		expect(title.getAttribute("title")).toBe("Noch keine Streams");
		expect(title.textContent).toBe("Noch keine Streams");
	});

	test("the Passport blank page header uses the catalog", async () => {
		const container = renderInGerman(<BlankFace empty={false} number={4} />);
		await settle();
		expect(container.textContent).toContain("Visa");
		expect(container.textContent).not.toContain("Visas");
	});
});
