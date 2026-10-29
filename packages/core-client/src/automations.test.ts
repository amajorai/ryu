// `phraseToSchedule` turns the automation picker's controls into a Core
// schedule. A cleared time input yields "" and must fall back to 9:00 rather
// than emit a cron with an empty field.

import { expect, test } from "bun:test";
import { phraseToSchedule } from "./automations.ts";

test("daily, weekday and weekend phrases use the picked time", () => {
	expect(phraseToSchedule("daily", "7:30", "monday", "9:00", "")).toEqual({
		kind: "cron",
		expr: "30 7 * * *",
	});
	expect(phraseToSchedule("weekdays", "18:05", "monday", "9:00", "")).toEqual({
		kind: "cron",
		expr: "05 18 * * 1-5",
	});
	expect(phraseToSchedule("weekends", "8:00", "monday", "9:00", "")).toEqual({
		kind: "cron",
		expr: "00 8 * * 0,6",
	});
});

test("a cleared or partial time defaults each missing part to 9:00", () => {
	expect(phraseToSchedule("daily", "", "monday", "9:00", "")).toEqual({
		kind: "cron",
		expr: "0 9 * * *",
	});
	expect(phraseToSchedule("weekdays", "14", "monday", "9:00", "")).toEqual({
		kind: "cron",
		expr: "0 14 * * 1-5",
	});
	expect(phraseToSchedule("weekly", "", "friday", "", "")).toEqual({
		kind: "cron",
		expr: "0 9 * * 5",
	});
});
