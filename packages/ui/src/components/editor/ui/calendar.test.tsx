import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { I18nProvider } from "@ryu/i18n/react";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

// The Plate date node's calendar is a vendored copy of the shared one. These
// cases pin the same display-language default the shared Calendar has, so the
// editor's date popover does not stay English under another display language.
const ownsDom = typeof document === "undefined";
if (ownsDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const { Calendar } = await import("./calendar.tsx");

let mounted: { container: HTMLElement; root: Root } | undefined;
afterEach(async () => {
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
});
afterAll(async () => {
	if (ownsDom) {
		await GlobalRegistrator.unregister();
	}
});

async function mount(node: ReactNode): Promise<HTMLElement> {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	mounted = { container, root };
	await act(async () => {
		root.render(node);
	});
	return container;
}

/** The pack the display language is, as Desktop's language host mounts it. */
function inGerman(node: ReactNode) {
	return (
		<I18nProvider
			autoLocalizeDom={false}
			initialPackId="official/de"
			persistPackId={() => undefined}
		>
			{node}
		</I18nProvider>
	);
}

const names = (calendar: HTMLElement) => ({
	nav: calendar.querySelector("nav")?.getAttribute("aria-label"),
	previous: calendar
		.querySelector(".rdp-button_previous")
		?.getAttribute("aria-label"),
	next: calendar.querySelector(".rdp-button_next")?.getAttribute("aria-label"),
	dropdowns: [...calendar.querySelectorAll("select")].map((select) =>
		select.getAttribute("aria-label")
	),
});
const weekdayNames = (calendar: HTMLElement) =>
	[...calendar.querySelectorAll("th[aria-label]")].map((header) =>
		header.getAttribute("aria-label")
	);
const weekdayText = (calendar: HTMLElement) =>
	[...calendar.querySelectorAll("th[aria-label]")].map(
		(header) => header.textContent
	);
const firstWeek = (calendar: HTMLElement) => {
	const days = [
		...(calendar
			.querySelector('[role="grid"] tbody tr')
			?.querySelectorAll<HTMLButtonElement>("button[data-day]") ?? []),
	];
	return [days.at(0)?.dataset.day, days.at(-1)?.dataset.day];
};

const march2026 = new Date(2026, 2, 1);

test("the editor Calendar given no localization follows the display language: German names, Monday-first week and German day values", async () => {
	document.documentElement.style.setProperty("--ryu-locale", "de");
	const container = await mount(
		inGerman(
			<Calendar
				captionLayout="dropdown"
				defaultMonth={march2026}
				mode="single"
			/>
		)
	);
	expect(names(container)).toEqual({
		nav: "Navigationsleiste",
		previous: "Zum vorherigen Monat",
		next: "Zum nächsten Monat",
		dropdowns: ["Monat auswählen", "Jahr auswählen"],
	});
	// March 2, 2026 is a Monday, so German columns run Montag to Sonntag and the
	// first row runs from February 23 to March 1.
	expect(weekdayNames(container)[0]).toBe("Montag");
	expect(weekdayNames(container)).toHaveLength(7);
	expect(firstWeek(container)).toEqual([
		new Date(2026, 1, 23).toLocaleDateString("de"),
		new Date(2026, 2, 1).toLocaleDateString("de"),
	]);
});

test("with no display language the editor Calendar keeps DayPicker's English names, abbreviations and Sunday-first week", async () => {
	const container = await mount(
		<Calendar captionLayout="dropdown" defaultMonth={march2026} mode="single" />
	);
	expect(names(container)).toEqual({
		nav: "Navigation bar",
		previous: "Go to the Previous Month",
		next: "Go to the Next Month",
		dropdowns: ["Choose the Month", "Choose the Year"],
	});
	expect(weekdayNames(container)[0]).toBe("Sunday");
	// DayPicker's own two-letter headers, not Intl's three-letter short names.
	expect(weekdayText(container)).toEqual([
		"Su",
		"Mo",
		"Tu",
		"We",
		"Th",
		"Fr",
		"Sa",
	]);
	expect(firstWeek(container)).toEqual(["3/1/2026", "3/7/2026"]);
});

test("a caller's own labels win key by key, and a caller's own locale keeps the display language out entirely", async () => {
	document.documentElement.style.setProperty("--ryu-locale", "de");
	const labelled = await mount(
		inGerman(
			<Calendar
				defaultMonth={march2026}
				formatters={{ formatWeekdayName: () => "·" }}
				labels={{ labelNext: () => "Weiter" }}
				mode="single"
			/>
		)
	);
	expect(names(labelled).next).toBe("Weiter");
	expect(names(labelled).previous).toBe("Zum vorherigen Monat");
	expect(weekdayNames(labelled)[0]).toBe("Montag");
	// The caller's weekday formatter replaces the display language's one only.
	expect(weekdayText(labelled)).toEqual(Array.from({ length: 7 }, () => "·"));

	await act(async () => {
		mounted?.root.unmount();
	});
	mounted?.container.remove();
	mounted = undefined;

	const owned = await mount(
		inGerman(
			<Calendar
				defaultMonth={march2026}
				locale={{ code: "en-US", options: { weekStartsOn: 3 } }}
				mode="single"
			/>
		)
	);
	// The caller named the locale, so nothing of the display language applies.
	expect(names(owned).next).toBe("Go to the Next Month");
	expect(weekdayNames(owned)[0]).toBe("Wednesday");
	expect(firstWeek(owned)[0]).toBe(
		new Date(2026, 1, 25).toLocaleDateString("en-US")
	);
});
