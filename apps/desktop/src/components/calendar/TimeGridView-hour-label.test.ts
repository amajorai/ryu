import { describe, expect, test } from "bun:test";
import { formatGridHourLabel } from "./TimeGridView-hour-label.ts";

// ICU writes a (narrow) no-break space before day periods on some runtimes.
const plain = (label: string) => label.replace(/[\s ]/gu, " ");

describe("formatGridHourLabel", () => {
	test("German uses a 24-hour clock", () => {
		expect(formatGridHourLabel(9, "de")).toBe("9:00");
		expect(formatGridHourLabel(15, "de")).toBe("15:00");
	});

	test("Arabic uses its 12-hour clock and day-period marks, not HH:mm", () => {
		// The digits are Latin or Arabic-Indic depending on the ICU data.
		expect(plain(formatGridHourLabel(9, "ar"))).toMatch(/^[9٩]:[0٠]{2} ص$/u);
		expect(plain(formatGridHourLabel(15, "ar"))).toMatch(/^[3٣]:[0٠]{2} م$/u);
	});

	test("Korean uses its 12-hour clock with a leading day period", () => {
		expect(plain(formatGridHourLabel(9, "ko"))).toBe("오전 9:00");
		expect(plain(formatGridHourLabel(15, "ko"))).toBe("오후 3:00");
	});

	test("US English uses a 12-hour clock", () => {
		expect(plain(formatGridHourLabel(15, "en-US"))).toBe("3:00 PM");
	});

	test("the label does not depend on the machine's time zone", () => {
		expect(formatGridHourLabel(0, "de")).toBe("0:00");
		expect(formatGridHourLabel(23, "de")).toBe("23:00");
	});

	test("out-of-range hours clamp into the day", () => {
		expect(formatGridHourLabel(-3, "de")).toBe("0:00");
		expect(formatGridHourLabel(30, "de")).toBe("23:00");
	});
});
