import { describe, expect, test } from "bun:test";
import { localizedTextOf } from "./localizedText.ts";
import {
	parseMount,
	validateContainerDestination,
} from "./vaultIsolation-mounts.ts";

describe("isolation mounts", () => {
	test("reserved and relative destinations are refused", () => {
		expect(() => validateContainerDestination("/etc")).toThrow(
			"--mount: refusing to mount over the reserved container path /etc."
		);
		expect(() => validateContainerDestination("data")).toThrow(
			"--mount destination data must be an absolute path."
		);
	});

	test("a malformed --mount names itself in a localized sentence", async () => {
		const error = (await parseMount(
			"a:b:c:d",
			"/home/u",
			{},
			"unix:///x"
		).catch((caught: unknown) => caught as Error)) as Error;
		expect(error.message).toBe("--mount a:b:c:d: expected SRC:DST[:ro|rw].");
		expect(localizedTextOf(error)?.source).toBe(
			"--mount {raw}: expected SRC:DST[:ro|rw]."
		);
	});
});
