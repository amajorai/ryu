import { describe, expect, test } from "bun:test";
import { integer, parseConnectArgs } from "./connect-args.ts";

describe("connect args", () => {
	test("value flags and positionals split; -- ends flag parsing", () => {
		expect(parseConnectArgs(["search", "--limit=3", "--", "--x"])).toEqual({
			positional: ["search", "--x"],
			values: { limit: "3" },
		});
	});

	test("whole numbers are checked against their range", () => {
		expect(integer(undefined, "--limit", 1, 25)).toBeUndefined();
		expect(integer("7", "--limit", 1, 25)).toBe(7);
		expect(() => integer("99", "--limit", 1, 25)).toThrow(
			"--limit must be a whole number from 1 to 25."
		);
	});
});
