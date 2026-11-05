import { describe, expect, test } from "bun:test";
import { mockupMonthGrid, mockupWeekdays } from "./mockup-weekdays.ts";

describe("mockupWeekdays", () => {
	test("German starts on Monday with German initials", () => {
		expect(mockupWeekdays("de").join(" ")).toBe("M D M D F S S");
	});

	test("US English starts on Sunday", () => {
		expect(mockupWeekdays("en-US").join(" ")).toBe("S M T W T F S");
	});

	test("Japanese starts on Sunday with Japanese weekday names", () => {
		expect(mockupWeekdays("ja").join(" ")).toBe("日 月 火 水 木 金 土");
	});

	test("Arabic starts on Saturday with no Latin letters", () => {
		const weekdays = mockupWeekdays("ar");
		expect(weekdays).toHaveLength(7);
		expect(weekdays.join("")).not.toMatch(/[A-Za-z]/u);
		expect(weekdays[0]).toBe(
			new Intl.DateTimeFormat("ar", {
				timeZone: "UTC",
				weekday: "narrow",
			}).format(Date.UTC(2026, 0, 10))
		);
	});
});

describe("mockupMonthGrid", () => {
	test("September 2026 under de begins on Monday 31 August", () => {
		const grid = mockupMonthGrid("de", 2026, 8);
		expect(grid.cells[0]).toEqual({
			day: 31,
			inMonth: false,
			key: "2026-08-31",
		});
		expect(grid.cells[1]).toMatchObject({ day: 1, inMonth: true });
		expect(grid.cells.length % 7).toBe(0);
	});

	test("September 2026 under en-US begins on Sunday 30 August", () => {
		const grid = mockupMonthGrid("en-US", 2026, 8);
		expect(grid.cells[0]).toMatchObject({ day: 30, inMonth: false });
		expect(grid.cells[2]).toMatchObject({ day: 1, inMonth: true });
		expect(grid.cells.filter((cell) => cell.inMonth)).toHaveLength(30);
		expect(grid.cells.at(-1)).toMatchObject({ day: 3, inMonth: false });
	});

	test("September 2026 under ar begins on Saturday 29 August", () => {
		const grid = mockupMonthGrid("ar", 2026, 8);
		expect(grid.cells[0]).toMatchObject({ day: 29, inMonth: false });
		expect(grid.cells[3]).toMatchObject({ day: 1, inMonth: true });
		expect(grid.cells).toHaveLength(35);
	});
});
