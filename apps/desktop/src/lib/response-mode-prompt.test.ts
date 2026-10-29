import { describe, expect, test } from "bun:test";
import {
	interfaceLevelForProductMode,
	RESPONSE_MODE_FIELD,
	responseModeCacheWarning,
} from "./response-mode-prompt.ts";

describe("response mode prompt-cache confirmation", () => {
	test("keeping the same level asks nothing", () => {
		expect(responseModeCacheWarning("simple", "simple")).toBeNull();
		expect(responseModeCacheWarning("expert", "expert")).toBeNull();
	});

	test("switching between Ryu Work and Code names the response mode for Ryu assistant threads", () => {
		for (const [current, next] of [
			["simple", "expert"],
			["expert", "simple"],
		] as const) {
			const warning = responseModeCacheWarning(current, next);
			expect(warning?.title).toBe("Apply now? This resets the prompt cache");
			expect(warning?.description).toStartWith(
				`${RESPONSE_MODE_FIELD} is part of the system prompt for every Ryu assistant thread.`
			);
		}
	});

	test("Bot is Ryu Work and every other product mode is Code", () => {
		expect(interfaceLevelForProductMode("bot")).toBe("simple");
		expect(interfaceLevelForProductMode("os")).toBe("expert");
		expect(interfaceLevelForProductMode("console")).toBe("expert");
	});
});
