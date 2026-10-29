import { describe, expect, test } from "bun:test";
import { RyuRateLimitError } from "@ryuhq/services";
import { formatError } from "../output.ts";

describe("formatError", () => {
	test("prints the Retry-After delay when the error carries one", () => {
		const error = new RyuRateLimitError({
			service: "notify",
			status: 429,
			message:
				"Too many failed authentication attempts; retry after the Retry-After delay.",
			requestId: "req_1",
			retryAfterSeconds: 60,
		});
		const lines = formatError(error).split("\n");
		expect(lines).toContain("  retryAfter: 60s");
		expect(lines.indexOf("  retryAfter: 60s")).toBe(
			lines.indexOf("  requestId: req_1") + 1
		);
	});

	test("omits the retryAfter line when the server sent no delay", () => {
		const error = new RyuRateLimitError({
			service: "notify",
			status: 429,
			message: "Slow down.",
		});
		expect(formatError(error)).not.toContain("retryAfter");
	});
});
