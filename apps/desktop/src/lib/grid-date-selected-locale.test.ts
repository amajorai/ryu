import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Real DOM/CSS publication boundary used by I18nProvider; native Intl is untouched.
GlobalRegistrator.register();
afterAll(async () => {
	await GlobalRegistrator.unregister();
});
const { formatDateForDisplay, formatDateToString, parseLocalDate } =
	await import("../../../../packages/ui/src/lib/data-grid.ts");
const { calendarLocalization } = await import(
	"../../../../packages/ui/src/components/calendar.tsx"
);

function withDocumentTokens(run: () => void) {
	const root = document.documentElement;
	const oldLocale = root.style.getPropertyValue("--ryu-locale");
	const oldZone = root.style.getPropertyValue("--ryu-timezone");
	const oldLang = root.lang;
	try {
		run();
	} finally {
		if (oldLocale) {
			root.style.setProperty("--ryu-locale", oldLocale);
		} else {
			root.style.removeProperty("--ryu-locale");
		}
		if (oldZone) {
			root.style.setProperty("--ryu-timezone", oldZone);
		} else {
			root.style.removeProperty("--ryu-timezone");
		}
		root.lang = oldLang;
	}
}
function publish(locale: string, zone: string) {
	document.documentElement.lang = locale === "system" ? "" : locale;
	document.documentElement.style.setProperty("--ryu-locale", locale);
	document.documentElement.style.setProperty("--ryu-timezone", zone);
}
function expected(locale?: string) {
	return new Intl.DateTimeFormat(locale, {
		year: "numeric",
		month: "numeric",
		day: "numeric",
		timeZone: "UTC",
	}).format(new Date("2026-01-15T12:00:00.000Z"));
}

describe("grid date selected locale with calendar conservation", () => {
	test("real locale changes and System restore update the grid date immediately", () =>
		withDocumentTokens(() => {
			expect(expected("de-DE")).not.toBe(expected("en-US"));
			for (const locale of ["de-DE", "en-US", "fr-FR", "de-DE"]) {
				publish(locale, "Pacific/Kiritimati");
				expect(formatDateForDisplay("2026-01-15")).toBe(expected(locale));
			}
			publish("system", "America/Los_Angeles");
			expect(formatDateForDisplay("2026-01-15")).toBe(expected());
		}));
	test("selected locale keeps calendar-only strings and local Date values on the same day across display zones", () =>
		withDocumentTokens(() => {
			const local = parseLocalDate("2026-01-15");
			expect(local).not.toBeNull();
			if (!local) {
				throw new Error("Actual calendar parser rejected fixture");
			}
			for (const zone of ["Pacific/Kiritimati", "America/Los_Angeles"]) {
				publish("de-DE", zone);
				expect(formatDateForDisplay("2026-01-15")).toBe(expected("de-DE"));
				expect(formatDateForDisplay(local)).toBe(expected("de-DE"));
				expect(formatDateToString(local)).toBe("2026-01-15");
				expect(formatDateForDisplay("2026-02-30")).toBe("2026-02-30");
				expect(formatDateForDisplay("")).toBe("");
			}
		}));
	test("accepted Date objects preserve early years, BCE and invalid-date behavior", () =>
		withDocumentTokens(() => {
			const early = new Date(0);
			early.setFullYear(99, 0, 15);
			early.setHours(0, 0, 0, 0);
			const bce = new Date(0);
			bce.setFullYear(-1, 0, 15);
			bce.setHours(0, 0, 0, 0);
			const invalid = new Date(Number.NaN);
			for (const zone of ["Pacific/Kiritimati", "America/Los_Angeles"]) {
				publish("de-DE", zone);
				for (const value of [early, bce, invalid]) {
					expect(formatDateForDisplay(value)).toBe(
						value.toLocaleDateString("de-DE")
					);
				}
			}
			document.documentElement.style.setProperty(
				"--ryu-locale",
				"invalid_locale"
			);
			expect(formatDateForDisplay(early)).toBe(early.toLocaleDateString());
		}));
});

/** The first weekday (0 = Sunday) the calendar's locale carries for `code`. */
function weekStart(code: string) {
	return calendarLocalization(code).locale?.options?.weekStartsOn;
}

/**
 * Replace the engine's week data for one run. `getWeekInfo` is the current
 * method (Chromium, Bun); `weekInfo` is the getter older engines ship instead.
 */
function withWeekData(
	data: { getWeekInfo?: false; weekInfo?: { firstDay: number } | false },
	run: () => void
) {
	const prototype = Intl.Locale.prototype;
	const saved = ["getWeekInfo", "weekInfo"].map(
		(name) => [name, Object.getOwnPropertyDescriptor(prototype, name)] as const
	);
	try {
		if (data.getWeekInfo === false) {
			Reflect.deleteProperty(prototype, "getWeekInfo");
		}
		if (data.weekInfo === false) {
			Reflect.deleteProperty(prototype, "weekInfo");
		} else if (data.weekInfo) {
			const info = data.weekInfo;
			Object.defineProperty(prototype, "weekInfo", {
				configurable: true,
				get: () => info,
			});
		}
		run();
	} finally {
		for (const [name, descriptor] of saved) {
			if (descriptor) {
				Object.defineProperty(prototype, name, descriptor);
			} else {
				Reflect.deleteProperty(prototype, name);
			}
		}
	}
}

describe("calendar week start follows the display locale", () => {
	test("each locale's own first weekday reaches the calendar locale", () => {
		expect(weekStart("de")).toBe(1);
		expect(weekStart("de-DE")).toBe(1);
		expect(weekStart("fr-FR")).toBe(1);
		expect(weekStart("en-US")).toBe(0);
		expect(weekStart("ar-EG")).toBe(6);
		expect(calendarLocalization("de").locale?.code).toBe("de");
		// An unsupported code keeps DayPicker's own English locale.
		expect(calendarLocalization("invalid_locale").locale).toBeUndefined();
	});

	test("an engine with only the weekInfo getter is read, and one with no week data keeps the Sunday default", () => {
		withWeekData({ getWeekInfo: false, weekInfo: { firstDay: 1 } }, () => {
			expect(weekStart("de")).toBe(1);
		});
		withWeekData({ getWeekInfo: false, weekInfo: { firstDay: 7 } }, () => {
			expect(weekStart("de")).toBe(0);
		});
		withWeekData({ getWeekInfo: false, weekInfo: false }, () => {
			expect(calendarLocalization("de").locale).toEqual({ code: "de" });
		});
		// Malformed week data is ignored rather than trusted.
		withWeekData({ getWeekInfo: false, weekInfo: { firstDay: 9 } }, () => {
			expect(calendarLocalization("de").locale).toEqual({ code: "de" });
		});
		expect(weekStart("de")).toBe(1);
	});
});
