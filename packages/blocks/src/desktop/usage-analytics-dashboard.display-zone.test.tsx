import {
	afterAll,
	afterEach,
	beforeEach,
	expect,
	setSystemTime,
	test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import type { Root } from "react-dom/client";
import type { UsageDateRange } from "./usage-analytics.ts";

// The computer is on New York time and the person chose another display zone.
// At NOW the two zones are on different civil dates, so a dashboard that works
// in the computer's day (or reads `new Date()` for today) cannot pass. The
// cases that follow pin the dates the date-range picker derives: its "today"
// bound, the preset ranges, the days a click selects, and the label.
const ownsDom = typeof document === "undefined";
if (ownsDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
Reflect.set(Element.prototype, "getAnimations", () => []);
process.env.TZ = "America/New_York";
const { createRoot } = await import("react-dom/client");
const { UsageAnalyticsDashboard } = await import(
	"./usage-analytics-dashboard.tsx"
);
const { resetTimezone, setTimezonePreference } = await import(
	"@ryu/ui/lib/timezone.ts"
);

// 2026-06-10T20:00Z is Wednesday 16:00 in New York and Thursday 05:00 in Tokyo.
const NOW = "2026-06-10T20:00:00.000Z";
// Tokyo's June 5 to June 11 (inclusive): midnight Tokyo is 15:00Z the day before.
const TOKYO_WEEK: UsageDateRange = {
	from: new Date("2026-06-04T15:00:00.000Z"),
	to: new Date("2026-06-11T15:00:00.000Z"),
};
// New York's June 4 to June 10 (inclusive): midnight New York (EDT) is 04:00Z.
const NEW_YORK_WEEK: UsageDateRange = {
	from: new Date("2026-06-04T04:00:00.000Z"),
	to: new Date("2026-06-11T04:00:00.000Z"),
};

let mounted: { container: HTMLElement; root: Root } | undefined;
let changes: UsageDateRange[] = [];

beforeEach(() => {
	setSystemTime(new Date(NOW));
	changes = [];
});
afterEach(async () => {
	if (mounted) {
		const { container, root } = mounted;
		await act(async () => {
			root.unmount();
		});
		container.remove();
		mounted = undefined;
	}
	document.body.replaceChildren();
	resetTimezone();
	setSystemTime();
});
afterAll(async () => {
	if (ownsDom) {
		await GlobalRegistrator.unregister();
	}
});

async function mountDashboard(range: UsageDateRange): Promise<HTMLElement> {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	mounted = { container, root };
	await act(async () => {
		root.render(
			<UsageAnalyticsDashboard
				analytics={null}
				granularity="daily"
				loading={false}
				model={null}
				onGranularityChange={() => undefined}
				onModelChange={() => undefined}
				onProviderChange={() => undefined}
				onRangeChange={(next) => changes.push(next)}
				onScopeChange={() => undefined}
				provider={null}
				range={range}
				scope="you"
			/>
		);
	});
	return container;
}

async function click(element: Element | null | undefined): Promise<void> {
	if (!(element instanceof HTMLElement)) {
		throw new Error("The control to click is not on the page");
	}
	await act(async () => {
		element.click();
	});
}

function trigger(container: HTMLElement): HTMLElement {
	const control = container.querySelector<HTMLElement>(
		'[aria-label="Choose usage date range"]'
	);
	if (!control) {
		throw new Error("The dashboard has no date range control");
	}
	return control;
}

const openPicker = async (container: HTMLElement) => click(trigger(container));

/** The picker's popup lives in a portal, so it is read from the document. */
function dayCell(isoDate: string): HTMLElement {
	const cell = document.querySelector<HTMLElement>(`td[data-day="${isoDate}"]`);
	if (!cell) {
		throw new Error(`The open calendar has no cell for ${isoDate}`);
	}
	return cell;
}

const isDisabled = (isoDate: string) =>
	dayCell(isoDate).querySelector("button")?.disabled === true;

const dayButton = (isoDate: string) => dayCell(isoDate).querySelector("button");

function preset(name: string): HTMLButtonElement | undefined {
	return [...document.querySelectorAll("button")].find(
		(candidate) => candidate.textContent?.trim() === name
	);
}

const iso = (range: UsageDateRange | undefined) =>
	range && { from: range.from.toISOString(), to: range.to.toISOString() };

test("offers Tokyo's today, which is ahead of the computer's date, and not the day after", async () => {
	setTimezonePreference("Asia/Tokyo");
	const container = await mountDashboard(TOKYO_WEEK);
	await openPicker(container);
	// It is Thursday June 11 in Tokyo even though New York is still on June 10.
	expect(isDisabled("2026-06-11")).toBe(false);
	expect(isDisabled("2026-06-12")).toBe(true);
	expect(dayCell("2026-06-11").getAttribute("data-today")).toBe("true");
});

test("does not offer a day that has not begun in a display zone behind the computer", async () => {
	// 2026-06-11T06:00Z is June 11 02:00 in New York and June 10 20:00 in
	// Honolulu, so the computer's `new Date()` is a day ahead of the display zone.
	setSystemTime(new Date("2026-06-11T06:00:00.000Z"));
	setTimezonePreference("Pacific/Honolulu");
	const container = await mountDashboard({
		from: new Date("2026-06-04T10:00:00.000Z"),
		to: new Date("2026-06-11T10:00:00.000Z"),
	});
	await openPicker(container);
	expect(isDisabled("2026-06-10")).toBe(false);
	expect(isDisabled("2026-06-11")).toBe(true);
	expect(dayCell("2026-06-10").getAttribute("data-today")).toBe("true");
});

test("builds each preset range from the display zone's midnight", async () => {
	setTimezonePreference("Asia/Tokyo");
	const container = await mountDashboard(TOKYO_WEEK);
	await openPicker(container);
	await click(preset("24 hours"));
	await openPicker(container);
	await click(preset("7 days"));
	await openPicker(container);
	await click(preset("30 days"));
	// Tokyo's June 11 starts at 15:00Z on June 10; its midnight after June 11
	// is 15:00Z on June 11. The 7 and 30 day presets end on the same instant.
	expect(changes.map(iso)).toEqual([
		{ from: "2026-06-10T15:00:00.000Z", to: "2026-06-11T15:00:00.000Z" },
		{ from: "2026-06-04T15:00:00.000Z", to: "2026-06-11T15:00:00.000Z" },
		{ from: "2026-05-12T15:00:00.000Z", to: "2026-06-11T15:00:00.000Z" },
	]);
});

test("turns a clicked earlier display-zone day into that zone's midnights", async () => {
	setTimezonePreference("Asia/Tokyo");
	// Tokyo's June 11 alone, which is today there.
	const container = await mountDashboard({
		from: new Date("2026-06-10T15:00:00.000Z"),
		to: new Date("2026-06-11T15:00:00.000Z"),
	});
	await openPicker(container);
	await click(dayButton("2026-06-08"));
	// The range grows back to June 8 and the picker closes. It runs from Tokyo's
	// June 8 midnight (June 7 15:00Z) to the midnight after June 11 (June 11 15:00Z).
	expect(changes.map(iso)).toEqual([
		{ from: "2026-06-07T15:00:00.000Z", to: "2026-06-11T15:00:00.000Z" },
	]);
	expect(document.querySelector("td[data-day]")).toBeNull();
});

test("turns a clicked later display-zone day into the midnight after it", async () => {
	setTimezonePreference("Asia/Tokyo");
	// Tokyo's June 5 to June 7.
	const container = await mountDashboard({
		from: new Date("2026-06-04T15:00:00.000Z"),
		to: new Date("2026-06-07T15:00:00.000Z"),
	});
	await openPicker(container);
	await click(dayButton("2026-06-10"));
	// Through the end of Tokyo's June 10, which is 15:00Z on June 10.
	expect(changes.map(iso)).toEqual([
		{ from: "2026-06-04T15:00:00.000Z", to: "2026-06-10T15:00:00.000Z" },
	]);
});

test("labels the range by its display-zone days, not the computer's", async () => {
	setTimezonePreference("Asia/Tokyo");
	const container = await mountDashboard(TOKYO_WEEK);
	// New York would read June 4 to June 11 for the same instants.
	expect(trigger(container).textContent).toContain(
		"Jun 5, 2026 – Jun 11, 2026"
	);
});

test("highlights the display-zone range in the open calendar", async () => {
	setTimezonePreference("Asia/Tokyo");
	const container = await mountDashboard(TOKYO_WEEK);
	await openPicker(container);
	const selected = [...document.querySelectorAll("td[data-selected]")].map(
		(cell) => cell.getAttribute("data-day")
	);
	expect(selected).toEqual([
		"2026-06-05",
		"2026-06-06",
		"2026-06-07",
		"2026-06-08",
		"2026-06-09",
		"2026-06-10",
		"2026-06-11",
	]);
});

test("moves the bound, the highlight and the label when the display zone changes with the picker open", async () => {
	const container = await mountDashboard(NEW_YORK_WEEK);
	await openPicker(container);
	// On the computer's own zone, today is New York's June 10.
	expect(isDisabled("2026-06-10")).toBe(false);
	expect(isDisabled("2026-06-11")).toBe(true);
	expect(trigger(container).textContent).toContain(
		"Jun 4, 2026 – Jun 10, 2026"
	);
	await act(async () => {
		setTimezonePreference("Asia/Tokyo");
	});
	expect(isDisabled("2026-06-11")).toBe(false);
	expect(isDisabled("2026-06-12")).toBe(true);
	// The same two instants end on Tokyo's June 11, not New York's June 10.
	expect(trigger(container).textContent).toContain(
		"Jun 4, 2026 – Jun 11, 2026"
	);
});

/** What the picker shows and sends when the display zone is the computer's own. */
async function observeOnComputerZone(zone: string) {
	setTimezonePreference(zone);
	const container = await mountDashboard(NEW_YORK_WEEK);
	await openPicker(container);
	const shown = {
		label: trigger(container).textContent,
		todayEnabled: !isDisabled("2026-06-10"),
		todayMarked: dayCell("2026-06-10").getAttribute("data-today"),
		tomorrowDisabled: isDisabled("2026-06-11"),
	};
	await click(preset("7 days"));
	await openPicker(container);
	await click(preset("24 hours"));
	return { shown, sent: changes.map(iso) };
}

const UNCHANGED = {
	shown: {
		label: expect.stringContaining("Jun 4, 2026 – Jun 10, 2026"),
		todayEnabled: true,
		todayMarked: "true",
		tomorrowDisabled: true,
	},
	// 00:00 New York (EDT) is 04:00Z.
	sent: [
		{ from: "2026-06-04T04:00:00.000Z", to: "2026-06-11T04:00:00.000Z" },
		{ from: "2026-06-10T04:00:00.000Z", to: "2026-06-11T04:00:00.000Z" },
	],
};

test("is unchanged when the display preference follows the computer's zone", async () => {
	expect(await observeOnComputerZone("system")).toEqual(UNCHANGED);
});

test("is unchanged when the display zone is explicitly the computer's own zone", async () => {
	expect(await observeOnComputerZone("America/New_York")).toEqual(UNCHANGED);
});
