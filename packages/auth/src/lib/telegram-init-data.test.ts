import { describe, expect, test } from "bun:test";
import {
	signTelegramInitData,
	TELEGRAM_INIT_DATA_MAX_AGE_SECONDS,
	telegramDataCheckString,
	verifyTelegramInitData,
} from "./telegram-init-data.ts";

const BOT_TOKEN = "123456:TEST-bot-token";
const NOW_SECONDS = 1_790_000_000;
const NOW = NOW_SECONDS * 1000;

function launchData(
	overrides: Record<string, string | null> = {},
	token = BOT_TOKEN
): string {
	const params = new URLSearchParams({
		auth_date: String(NOW_SECONDS - 30),
		query_id: "AAHdF6IQAAAAAN0XohDhrOrc",
		signature: "c2lnbmF0dXJl",
		user: JSON.stringify({
			first_name: "Ada",
			id: 279_058_397,
			language_code: "en",
			username: "Ada_Lovelace",
		}),
	});
	for (const [key, value] of Object.entries(overrides)) {
		if (value === null) {
			params.delete(key);
		} else {
			params.set(key, value);
		}
	}
	params.set("hash", signTelegramInitData(params, token));
	return params.toString();
}

describe("telegramDataCheckString", () => {
	test("sorts every field except hash and joins with newlines", () => {
		const params = new URLSearchParams("b=2&hash=ff&a=1&signature=s");
		expect(telegramDataCheckString(params)).toBe("a=1\nb=2\nsignature=s");
	});
});

describe("verifyTelegramInitData", () => {
	test("accepts Telegram-signed launch data and returns the user", () => {
		const result = verifyTelegramInitData(launchData(), BOT_TOKEN, {
			now: NOW,
		});
		expect(result).toEqual({
			authDate: NOW_SECONDS - 30,
			ok: true,
			user: { firstName: "Ada", id: "279058397", username: "ada_lovelace" },
		});
	});

	test("rejects data signed for another bot", () => {
		const result = verifyTelegramInitData(
			launchData({}, "999:other-bot"),
			BOT_TOKEN,
			{ now: NOW }
		);
		expect(result).toEqual({ ok: false, reason: "bad_signature" });
	});

	test("rejects a tampered user after signing", () => {
		const params = new URLSearchParams(launchData());
		params.set("user", JSON.stringify({ first_name: "Eve", id: 1 }));
		const result = verifyTelegramInitData(params.toString(), BOT_TOKEN, {
			now: NOW,
		});
		expect(result).toEqual({ ok: false, reason: "bad_signature" });
	});

	test("rejects stale and far-future launches", () => {
		const stale = launchData({
			auth_date: String(NOW_SECONDS - TELEGRAM_INIT_DATA_MAX_AGE_SECONDS - 1),
		});
		const future = launchData({ auth_date: String(NOW_SECONDS + 3600) });
		expect(verifyTelegramInitData(stale, BOT_TOKEN, { now: NOW })).toEqual({
			ok: false,
			reason: "expired",
		});
		expect(verifyTelegramInitData(future, BOT_TOKEN, { now: NOW })).toEqual({
			ok: false,
			reason: "expired",
		});
	});

	test("requires a signed user", () => {
		const result = verifyTelegramInitData(
			launchData({ user: null }),
			BOT_TOKEN,
			{ now: NOW }
		);
		expect(result).toEqual({ ok: false, reason: "missing_user" });
	});

	test("rejects malformed input without hashing it", () => {
		for (const input of [
			"",
			"auth_date=1",
			"hash=nothex",
			`hash=${"a".repeat(64)}&hash=${"b".repeat(64)}`,
			"x".repeat(9000),
		]) {
			expect(verifyTelegramInitData(input, BOT_TOKEN, { now: NOW })).toEqual({
				ok: false,
				reason: "malformed",
			});
		}
		expect(verifyTelegramInitData(launchData(), "", { now: NOW })).toEqual({
			ok: false,
			reason: "malformed",
		});
	});
});
