import { expect, test } from "bun:test";
import { formatTtl, parseTtl, timestampMillis } from "./vault-ttl.ts";

test("typed durations become seconds, blank is unset and junk is refused", () => {
	expect(parseTtl("")).toBeUndefined();
	expect(parseTtl("  ")).toBeUndefined();
	expect(parseTtl("90")).toBe(90);
	expect(parseTtl("90s")).toBe(90);
	expect(parseTtl("15m")).toBe(900);
	expect(parseTtl("1H")).toBe(3600);
	expect(parseTtl("7d")).toBe(604_800);
	expect(parseTtl("0")).toBeNull();
	expect(parseTtl("1.5h")).toBeNull();
	expect(parseTtl("-5")).toBeNull();
	expect(parseTtl("1w")).toBeNull();
});

test("seconds format as the largest exact unit and round-trip", () => {
	expect(formatTtl(undefined)).toBe("");
	expect(formatTtl(0)).toBe("");
	expect(formatTtl(90)).toBe("90s");
	expect(formatTtl(900)).toBe("15m");
	expect(formatTtl(3600)).toBe("1h");
	expect(formatTtl(86_400 * 2)).toBe("2d");
	for (const secs of [45, 600, 7200, 172_800]) {
		expect(parseTtl(formatTtl(secs))).toBe(secs);
	}
});

test("timestamps read from millis or ISO text", () => {
	expect(timestampMillis(5)).toBe(5);
	expect(timestampMillis("1970-01-01T00:00:01.000Z")).toBe(1000);
	expect(timestampMillis("soon")).toBeNull();
	expect(timestampMillis(null)).toBeNull();
});
