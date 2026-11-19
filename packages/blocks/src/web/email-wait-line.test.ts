import { describe, expect, test } from "bun:test";
import { authEmailWaitLine, emailWaitSentence } from "./email-wait-line.ts";

describe("authEmailWaitLine", () => {
	test("says the wait of a refused email request", () => {
		expect(authEmailWaitLine({ retryAfter: 42, status: 429 })).toBe(
			"Please wait 42 seconds before requesting another email."
		);
		expect(authEmailWaitLine({ retryAfter: 5 * 3600, status: 429 })).toBe(
			"Please wait 5 hours before requesting another email."
		);
	});

	test("leaves any other error to the caller", () => {
		expect(authEmailWaitLine({ status: 429 })).toBeNull();
		expect(authEmailWaitLine({ retryAfter: 30, status: 400 })).toBeNull();
		expect(authEmailWaitLine(null)).toBeNull();
	});

	test("translates through the given catalog", () => {
		const seen: string[] = [];
		emailWaitSentence(120, (source) => {
			seen.push(source);
			return source;
		});
		expect(seen).toEqual([
			"Please wait {count, plural, one {# minute} other {# minutes}} before requesting another email.",
		]);
	});
});
