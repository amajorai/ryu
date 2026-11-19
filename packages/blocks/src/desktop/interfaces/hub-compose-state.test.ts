import { describe, expect, test } from "bun:test";
import { formatMessage } from "@ryu/i18n/lite";
import type { LiteralMessage } from "@ryu/i18n/react";
import { hubAgentStateLabel } from "./hub-compose.tsx";

const seen: string[] = [];
const tl: LiteralMessage = (source, values) => {
	seen.push(source);
	return formatMessage(source, values);
};

describe("hubAgentStateLabel", () => {
	test("idle, one run, and several runs read as whole phrases", () => {
		expect(hubAgentStateLabel(false, 0, tl)).toBe("Idle");
		expect(hubAgentStateLabel(true, 1, tl)).toBe("Working");
		expect(hubAgentStateLabel(true, 0, tl)).toBe("Working");
		expect(hubAgentStateLabel(true, 3, tl)).toBe("Working on 3");
	});

	test("the count goes through one ICU plural message", () => {
		seen.length = 0;
		hubAgentStateLabel(true, 4, tl);
		expect(seen).toEqual([
			"{count, plural, =0 {Working} =1 {Working} other {Working on #}}",
		]);
	});
});
