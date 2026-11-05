import { afterEach, describe, expect, test } from "bun:test";
import {
	type ActiveI18nRuntime,
	registerActiveI18nRuntime,
	unregisterActiveI18nRuntime,
} from "./active-locale.ts";
import {
	errorText,
	isNetworkFailure,
	normalizeNetworkError,
	rethrowNetworkFailure,
} from "./error-text.ts";
import { messageIdForLiteral } from "./literal-catalog.ts";

const SENTENCE =
	"Couldn't reach the server. Check your connection and try again.";
const JAPANESE =
	"サーバーに接続できませんでした。接続を確認してもう一度お試しください。";

const japanese: ActiveI18nRuntime = {
	direction: "ltr",
	locale: "ja",
	translate: (id, _values, fallback) =>
		id === messageIdForLiteral(SENTENCE) ? JAPANESE : (fallback ?? id),
};

afterEach(() => {
	unregisterActiveI18nRuntime(japanese);
});

describe("isNetworkFailure", () => {
	test("recognises the Chromium, Safari and Firefox fetch rejections", () => {
		for (const message of [
			"Failed to fetch",
			"Load failed",
			"NetworkError when attempting to fetch resource.",
		]) {
			expect(isNetworkFailure(new TypeError(message))).toBe(true);
		}
	});

	test("leaves other errors alone", () => {
		expect(isNetworkFailure(new Error("Failed to fetch"))).toBe(false);
		expect(isNetworkFailure(new TypeError("x is not a function"))).toBe(false);
		expect(isNetworkFailure("Failed to fetch")).toBe(false);
		expect(isNetworkFailure(null)).toBe(false);
	});
});

describe("normalizeNetworkError", () => {
	test("replaces a network failure and keeps the original as cause", () => {
		const original = new TypeError("Failed to fetch");
		const normalized = normalizeNetworkError(original);
		expect(normalized).toBeInstanceOf(Error);
		expect((normalized as Error).message).toBe(SENTENCE);
		expect((normalized as Error).cause).toBe(original);
	});

	test("passes any other error through unchanged", () => {
		const original = new Error("Plan limit reached");
		expect(normalizeNetworkError(original)).toBe(original);
	});

	test("answers in the active language", () => {
		registerActiveI18nRuntime(japanese);
		const normalized = normalizeNetworkError(new TypeError("Load failed"));
		expect((normalized as Error).message).toBe(JAPANESE);
	});
});

describe("rethrowNetworkFailure", () => {
	test("rejects a failed fetch with the translated sentence", async () => {
		registerActiveI18nRuntime(japanese);
		const failing = Promise.reject(new TypeError("Failed to fetch"));
		await expect(failing.catch(rethrowNetworkFailure)).rejects.toThrow(
			JAPANESE
		);
	});

	test("rethrows other rejections as they are", async () => {
		const original = new Error("Server said no");
		await expect(
			Promise.reject(original).catch(rethrowNetworkFailure)
		).rejects.toBe(original);
	});
});

describe("errorText", () => {
	test("picks the network sentence, the message, or the fallback", () => {
		expect(errorText(new TypeError("Failed to fetch"), "Fallback")).toBe(
			SENTENCE
		);
		expect(errorText(new Error("Specific"), "Fallback")).toBe("Specific");
		expect(errorText("boom", "Fallback")).toBe("Fallback");
	});
});
