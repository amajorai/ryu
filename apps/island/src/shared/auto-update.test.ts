import { describe, expect, it } from "bun:test";
import {
	DEFAULT_AUTO_UPDATE,
	parseAutoUpdate,
	serializeAutoUpdate,
} from "./auto-update.ts";

describe("parseAutoUpdate", () => {
	it("defaults to enabled for null/empty/malformed input", () => {
		expect(DEFAULT_AUTO_UPDATE).toEqual({ enabled: true });
		expect(parseAutoUpdate(null)).toEqual({ enabled: true });
		expect(parseAutoUpdate("")).toEqual({ enabled: true });
		expect(parseAutoUpdate("{bad")).toEqual({ enabled: true });
	});

	it("only an explicit false disables updates", () => {
		expect(parseAutoUpdate(JSON.stringify({ enabled: false })).enabled).toBe(
			false
		);
		expect(parseAutoUpdate(JSON.stringify({ enabled: true })).enabled).toBe(
			true
		);
		// A non-boolean value never silently disables updates.
		expect(
			parseAutoUpdate(JSON.stringify({ enabled: "off" as unknown })).enabled
		).toBe(true);
		expect(parseAutoUpdate(JSON.stringify({})).enabled).toBe(true);
	});
});

describe("serializeAutoUpdate", () => {
	it("round-trips through parseAutoUpdate", () => {
		for (const enabled of [true, false]) {
			const raw = serializeAutoUpdate({ enabled });
			expect(JSON.parse(raw)).toEqual({ enabled });
			expect(parseAutoUpdate(raw).enabled).toBe(enabled);
		}
	});
});
