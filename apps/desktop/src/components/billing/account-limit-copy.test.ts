// apps/desktop/src/components/billing/account-limit-copy.test.ts
//
// The sentences for the limit on connected accounts per provider at 9, 10, 11
// and 12 accounts, on the free limit and on the licensed one.

import { describe, expect, test } from "bun:test";
import type { LiteralMessage } from "@ryu/i18n/react";
import { accountLimitStanding } from "@/src/lib/gating/accountLimit.ts";
import {
	accountCountText,
	accountLimitMessage,
	accountLimitToast,
} from "./account-limit-copy.ts";

/** English with the values filled in, as `tl` gives with no catalog. */
const tl: LiteralMessage = (source, values) => {
	// `LiteralMessage` takes its values as unknown, so narrow them to an object
	// before reading a placeholder from them.
	const filled: object =
		typeof values === "object" && values !== null ? values : {};
	return source.replace(/\{(\w+)\}/g, (_match, name: string) =>
		String(Reflect.get(filled, name))
	);
};

describe("the count", () => {
	test("reads as accounts held of accounts allowed", () => {
		expect(accountCountText({ count: 9, limit: 10 }, tl)).toBe(
			"9 of 10 accounts"
		);
		expect(accountCountText({ count: 12, limit: 10 }, tl)).toBe(
			"12 of 10 accounts"
		);
	});
});

describe("the reason", () => {
	test("is absent while there is room", () => {
		expect(accountLimitMessage(accountLimitStanding(9, 10), tl)).toBeNull();
		expect(accountLimitMessage(accountLimitStanding(49, 50), tl)).toBeNull();
	});

	test("at the free limit names the license and its number", () => {
		expect(accountLimitMessage(accountLimitStanding(10, 10), tl)).toBe(
			"This provider has the most accounts the free plan allows. Remove one, or get a license to connect up to 50."
		);
	});

	test("above the free limit says the accounts stay and how many must go", () => {
		expect(accountLimitMessage(accountLimitStanding(11, 10), tl)).toBe(
			"This provider has more accounts than the free plan allows. They all keep working. Remove 2 to add a new one, or get a license to connect up to 50."
		);
		expect(accountLimitMessage(accountLimitStanding(12, 10), tl)).toContain(
			"Remove 3 to add a new one"
		);
	});

	test("at the licensed limit offers no license", () => {
		const full = accountLimitMessage(accountLimitStanding(50, 50), tl);
		expect(full).toBe(
			"This provider already has the most accounts your plan allows. Remove one to add another."
		);
		const over = accountLimitMessage(accountLimitStanding(52, 50), tl);
		expect(over).toBe(
			"This provider has more accounts than your plan allows. They all keep working. Remove 3 to add a new one."
		);
		expect(`${full} ${over}`).not.toContain("license");
	});
});

describe("the toast after Core refuses an add", () => {
	test("on the free limit explains it and opens the paywall", () => {
		let opened = 0;
		const toast = accountLimitToast(
			{ count: 10, limit: 10, provider: "anthropic" },
			tl,
			() => {
				opened += 1;
			}
		);
		expect(toast.title).toBe("Account limit reached");
		expect(toast.description).toContain("get a license to connect up to 50");
		expect(toast.button?.title).toBe("Get a license");
		toast.button?.onClick();
		expect(opened).toBe(1);
	});

	test("uses the numbers Core sent, not the desktop's own", () => {
		const toast = accountLimitToast(
			{ count: 13, limit: 10, provider: null },
			tl
		);
		expect(toast.description).toContain("Remove 4 to add a new one");
		// Nothing can open the paywall here, so there is no button.
		expect(toast.button).toBeUndefined();
	});

	test("on the licensed limit has no license button", () => {
		const toast = accountLimitToast(
			{ count: 50, limit: 50, provider: "openai" },
			tl,
			() => undefined
		);
		expect(toast.button).toBeUndefined();
		expect(toast.description).toBe(
			"This provider already has the most accounts your plan allows. Remove one to add another."
		);
	});

	test("still says why when the numbers show room", () => {
		const toast = accountLimitToast(
			{ count: 3, limit: 10, provider: "openai" },
			tl
		);
		expect(toast.description).toBe(
			"This provider already has the most accounts your plan allows. Remove one to add another."
		);
	});
});
