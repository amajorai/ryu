import { afterAll, afterEach, expect, setSystemTime, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
	createTable,
	getCoreRowModel,
	type TableMeta,
} from "@tanstack/react-table";
import { act, type ReactNode, useMemo, useState } from "react";
import { createRoot, type Root } from "react-dom/client";

const ownsDom = typeof document === "undefined";
if (ownsDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
Reflect.set(Element.prototype, "getAnimations", () => []);
const { DateCell } = await import(
	"../../../../packages/ui/src/components/data-grid/data-grid-cell-variants.tsx"
);
const { I18nProvider } = await import("@ryu/i18n/react");

interface DateRecord {
	date: string;
	id: string;
	unrelated: string;
}
interface DateUpdate {
	columnId: string;
	rowIndex: number;
	value: unknown;
}

const originalRecords: DateRecord[] = [
	{ id: "edited", date: "2026-03-15", unrelated: "retained" },
	{ id: "foreign", date: "2025-12-31", unrelated: "other row" },
];

let mounted: { container: HTMLElement; root: Root } | undefined;
afterEach(async () => {
	setSystemTime();
	if (mounted) {
		const { container, root } = mounted;
		await act(async () => {
			root.unmount();
		});
		container.remove();
		mounted = undefined;
	}
	document.documentElement.style.removeProperty("--ryu-locale");
	document.documentElement.removeAttribute("lang");
	document.documentElement.removeAttribute("dir");
});
afterAll(async () => {
	if (ownsDom) {
		await GlobalRegistrator.unregister();
	}
});

const settle = async () => {
	await act(async () => {
		// Base UI resolves the popup's initial focus in a microtask, then a frame.
		await new Promise((resolve) => setTimeout(resolve, 40));
	});
};

/** The genuine DateCell inside a real TanStack table that owns its records. */
async function mountDateCell(
	initial: DateRecord[],
	host: (grid: ReactNode) => ReactNode = (grid) => grid
) {
	const updates: DateUpdate[] = [];
	const records: { current: DateRecord[] } = { current: initial };
	function Grid() {
		const [rows, setRows] = useState(initial);
		const [editing, setEditing] = useState(false);
		records.current = rows;
		const meta = useMemo<TableMeta<DateRecord>>(
			() => ({
				onCellEditingStart: () => setEditing(true),
				onCellEditingStop: () => setEditing(false),
				onDataUpdate: (update) => {
					if (Array.isArray(update)) {
						throw new Error("DateCell sent a batch update");
					}
					updates.push(update);
					setRows((current) =>
						current.map((row, index) =>
							index === update.rowIndex
								? { ...row, [update.columnId]: update.value }
								: row
						)
					);
				},
			}),
			[]
		);
		const table = useMemo(
			() =>
				createTable({
					data: rows,
					columns: [{ accessorKey: "date" }],
					getCoreRowModel: getCoreRowModel(),
					state: {},
					onStateChange: () => {},
					renderFallbackValue: null,
				}),
			[rows]
		);
		const cell = table.getRowModel().rows[0]?.getAllCells()[0];
		if (!cell) {
			throw new Error("TanStack produced no date cell");
		}
		return (
			<DateCell
				cell={cell}
				columnId="date"
				isActiveSearchMatch={false}
				isEditing={editing}
				isFocused
				isSearchMatch={false}
				isSelected={false}
				readOnly={false}
				rowHeight="short"
				rowIndex={0}
				tableMeta={meta}
			/>
		);
	}
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	mounted = { container, root };
	await act(async () => {
		root.render(host(<Grid />));
	});
	const cell = container.querySelector<HTMLElement>(
		'[data-slot="grid-cell-wrapper"]'
	);
	if (!cell) {
		throw new Error("DateCell rendered no focusable grid cell");
	}
	return { cell, container, records, updates };
}

const editor = () => document.querySelector("[data-grid-cell-editor]");
const active = () => document.activeElement as HTMLElement | null;
const press = async (target: Element | null, key: string) => {
	if (!target) {
		throw new Error(`No element to receive ${key}`);
	}
	await act(async () => {
		target.dispatchEvent(
			new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key })
		);
	});
	await settle();
};
/** The weekday column names, in the order the grid shows them. */
const weekdayHeaders = () =>
	[...(editor()?.querySelectorAll("th[aria-label]") ?? [])].map((header) =>
		header.getAttribute("aria-label")
	);
/** The accessible names of the calendar's navigation and caption controls. */
const navigationNames = () => {
	const calendar = editor()?.querySelector('[data-slot="calendar"]');
	const selects = [...(calendar?.querySelectorAll("select") ?? [])];
	return {
		nav: calendar?.querySelector("nav")?.getAttribute("aria-label"),
		previous: calendar
			?.querySelector(".rdp-button_previous")
			?.getAttribute("aria-label"),
		next: calendar
			?.querySelector(".rdp-button_next")
			?.getAttribute("aria-label"),
		dropdowns: selects.map((select) => select.getAttribute("aria-label")),
	};
};
/** The `data-day` of the first and last day cells of the grid's first week. */
const firstWeek = () => {
	const days = [
		...(editor()
			?.querySelector('[role="grid"] tbody tr')
			?.querySelectorAll<HTMLButtonElement>("button[data-day]") ?? []),
	];
	return [days.at(0)?.dataset.day, days.at(-1)?.dataset.day];
};
const openWithF2 = async (cell: HTMLElement) => {
	cell.focus();
	if (active() !== cell) {
		throw new Error("The date cell did not take keyboard focus");
	}
	await press(cell, "F2");
	if (!editor()) {
		throw new Error("F2 did not open the date editor");
	}
};

test("F2 lands on the selected day, arrows move real focus, Escape cancels and activating the focused day acknowledges one update", async () => {
	const { cell, records, updates } = await mountDateCell(
		structuredClone(originalRecords)
	);
	await openWithF2(cell);
	// The selected civil day, not "Go to the Previous Month".
	expect(active()?.getAttribute("aria-label")).toBe(
		"Sunday, March 15, 2026, selected"
	);
	expect(active()?.dataset.selectedSingle).toBe("true");
	// English keeps its Sunday-first week and its navigation names.
	expect(weekdayHeaders()).toEqual([
		"Sunday",
		"Monday",
		"Tuesday",
		"Wednesday",
		"Thursday",
		"Friday",
		"Saturday",
	]);
	expect(firstWeek()).toEqual(["3/1/2026", "3/7/2026"]);
	expect(navigationNames()).toEqual({
		nav: "Navigation bar",
		previous: "Go to the Previous Month",
		next: "Go to the Next Month",
		dropdowns: ["Choose the Month", "Choose the Year"],
	});
	await press(active(), "ArrowRight");
	expect(active()?.getAttribute("aria-label")).toBe("Monday, March 16, 2026");
	await press(active(), "ArrowDown");
	expect(active()?.getAttribute("aria-label")).toBe("Monday, March 23, 2026");
	expect(updates).toEqual([]);

	await press(active(), "Escape");
	expect(editor()).toBeNull();
	expect(updates).toEqual([]);
	expect(records.current).toEqual(originalRecords);
	expect(
		cell.querySelector('[data-slot="grid-cell-content"]')?.textContent
	).toBe("3/15/2026");

	// Reopen: the cancelled navigation is forgotten; the saved day is focused.
	await openWithF2(cell);
	expect(active()?.getAttribute("aria-label")).toBe(
		"Sunday, March 15, 2026, selected"
	);
	await press(active(), "ArrowRight");
	// happy-dom does not turn a dispatched Enter into a click; the genuine Enter
	// key is proved in Chromium (e2e/time-consumers.spec.ts).
	await act(async () => {
		active()?.click();
	});
	await settle();
	expect(editor()).toBeNull();
	expect(updates).toEqual([
		{ rowIndex: 0, columnId: "date", value: "2026-03-16" },
	]);
	expect(records.current).toEqual([
		{ id: "edited", date: "2026-03-16", unrelated: "retained" },
		{ id: "foreign", date: "2025-12-31", unrelated: "other row" },
	]);
	expect(
		cell.querySelector('[data-slot="grid-cell-content"]')?.textContent
	).toBe("3/16/2026");
});

test("F2 on an empty date lands on today", async () => {
	setSystemTime(new Date(2026, 2, 10, 14, 0));
	const { cell } = await mountDateCell([
		{ id: "empty", date: "", unrelated: "retained" },
	]);
	await openWithF2(cell);
	expect(active()?.getAttribute("aria-label")).toBe(
		"Today, Tuesday, March 10, 2026"
	);
});

test("F2 on an empty date opens the month of today in the display zone, not the computer's", async () => {
	const machineZone = process.env.TZ;
	const { resetTimezone, setTimezonePreference } = await import(
		"@ryu/ui/lib/timezone.ts"
	);
	try {
		// 2026-06-30T20:00Z is Tuesday June 30 16:00 in New York and Wednesday
		// July 1 05:00 in Tokyo, so the two zones are in different months.
		process.env.TZ = "America/New_York";
		setTimezonePreference("Asia/Tokyo");
		setSystemTime(new Date("2026-06-30T20:00:00.000Z"));
		const { cell } = await mountDateCell([
			{ id: "empty", date: "", unrelated: "retained" },
		]);
		await openWithF2(cell);
		const month = editor()?.querySelector<HTMLSelectElement>(
			'select[aria-label="Choose the Month"]'
		);
		expect({
			focused: active()?.getAttribute("aria-label"),
			// The month dropdown's value is the zero-based month: July is 6.
			month: month?.value,
		}).toEqual({ focused: "Today, Wednesday, July 1, 2026", month: "6" });
	} finally {
		resetTimezone();
		if (machineZone === undefined) {
			Reflect.deleteProperty(process.env, "TZ");
		} else {
			process.env.TZ = machineZone;
		}
	}
});

// happy-dom 20.10.6 holds each MutationObserver callback only through a
// WeakRef, so observers can go silent after a collection. Switching the
// language while the editor is open is therefore proved in Chromium
// (e2e/time-consumers.spec.ts); here the language is chosen before F2.
test("an editor opened under a German display language names its days and navigation in German, starts the week on Monday and keeps the civil value", async () => {
	document.documentElement.style.setProperty("--ryu-locale", "de");
	// The shipping German pack is the display language. The document localizer
	// is off, so every name below is the calendar's own label, not a rewrite.
	const { cell, records, updates } = await mountDateCell(
		structuredClone(originalRecords),
		(grid) => (
			<I18nProvider
				autoLocalizeDom={false}
				initialPackId="official/de"
				persistPackId={() => undefined}
			>
				{grid}
			</I18nProvider>
		)
	);
	const german = (day: number, options: Intl.DateTimeFormatOptions) =>
		new Intl.DateTimeFormat("de", options).format(new Date(2026, 2, day));
	expect(
		cell.querySelector('[data-slot="grid-cell-content"]')?.textContent
	).toBe(new Date(2026, 2, 15).toLocaleDateString("de"));
	await openWithF2(cell);
	expect(active()?.getAttribute("aria-label")).toBe(
		`${german(15, { dateStyle: "full" })}, selected`
	);
	expect(active()?.getAttribute("data-day")).toBe(
		new Date(2026, 2, 15).toLocaleDateString("de")
	);
	expect(navigationNames()).toEqual({
		nav: "Navigationsleiste",
		previous: "Zum vorherigen Monat",
		next: "Zum nächsten Monat",
		dropdowns: ["Monat auswählen", "Jahr auswählen"],
	});
	// German weeks start on Monday: March 2, 2026 is a Monday, so the columns
	// read Montag to Sonntag and the first row runs from February 23 to March 1.
	expect(weekdayHeaders()).toEqual(
		[2, 3, 4, 5, 6, 7, 8].map((day) => german(day, { weekday: "long" }))
	);
	expect(weekdayHeaders()[0]).toBe("Montag");
	expect(firstWeek()).toEqual([
		new Date(2026, 1, 23).toLocaleDateString("de"),
		new Date(2026, 2, 1).toLocaleDateString("de"),
	]);
	expect(
		editor()?.querySelector('[data-slot="calendar"]')?.getAttribute("lang")
	).toBe("de");
	await press(active(), "ArrowRight");
	expect(active()?.getAttribute("aria-label")).toBe(
		german(16, { dateStyle: "full" })
	);
	await press(active(), "Escape");
	expect(editor()).toBeNull();
	expect(updates).toEqual([]);
	expect(records.current).toEqual(originalRecords);
});
