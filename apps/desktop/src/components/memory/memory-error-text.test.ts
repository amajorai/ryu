import { describe, expect, it } from "bun:test";
import { ApiError } from "@/src/lib/api/client.ts";
import { memoryErrorText } from "./memory-error-text.ts";

const FALLBACK = "メモリを保存できませんでした。";

describe("memoryErrorText", () => {
	it("shows Core's refusal when the response carried one", () => {
		const error = new ApiError("/api/memory", 400, "Memory content is empty");
		expect(memoryErrorText(error, FALLBACK)).toBe("Memory content is empty");
	});

	it("uses the fallback, never the transport message, when Core sent none", () => {
		const error = new ApiError("/api/memory", 400);
		const text = memoryErrorText(error, FALLBACK);
		expect(text).toBe(FALLBACK);
		expect(text).not.toContain("/api/memory failed");
	});

	it("uses the fallback for any other error", () => {
		expect(memoryErrorText(new Error("socket hang up"), FALLBACK)).toBe(
			FALLBACK
		);
		expect(memoryErrorText("boom", FALLBACK)).toBe(FALLBACK);
	});
});
