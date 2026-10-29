import { expect, test } from "bun:test";
import { phraseToSchedule } from "./automations.ts";

test("unrecognized weekday names use the Monday fallback", () => {
	for (const weekday of ["unknown", "constructor", "__proto__", "toString"]) {
		expect(
			phraseToSchedule("weekly", "09:00", weekday, "13:42", "raw")
		).toEqual({
			kind: "cron",
			expr: "42 13 * * 1",
		});
	}
});
