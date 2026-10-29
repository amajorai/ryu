import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

/**
 * Telegram Mini App `initData` verification.
 *
 * Telegram signs the launch parameters it hands a Mini App with a key derived
 * from the bot token: `secret = HMAC_SHA256(key = "WebAppData", bot_token)` and
 * `hash = hex(HMAC_SHA256(key = secret, data_check_string))`, where the check
 * string is every field except `hash`, as `key=value`, sorted by key and joined
 * by `\n`. `initDataUnsafe` in the browser is only a parsed copy of the same
 * string, so the server must re-verify the raw string before trusting a user id.
 *
 * Kept free of request and database access so the rules stay unit-testable.
 */

const WEB_APP_DATA_KEY = "WebAppData";
const TELEGRAM_HASH_RE = /^[0-9a-f]{64}$/;
const TELEGRAM_USER_ID_RE = /^\d{1,32}$/;
const TELEGRAM_USERNAME_RE = /^[A-Za-z0-9_]{5,32}$/;
/** Bound a hostile payload before hashing it. Real launch data is ~1 KB. */
export const TELEGRAM_INIT_DATA_MAX_LENGTH = 8192;
/** How long a launch's `initData` may be exchanged for a Ryu session. */
export const TELEGRAM_INIT_DATA_MAX_AGE_SECONDS = 60 * 60;
/** Allow modest clock skew between Telegram and this server. */
const TELEGRAM_INIT_DATA_FUTURE_SKEW_SECONDS = 60;

export interface TelegramMiniAppUser {
	firstName: string | null;
	id: string;
	username: string | null;
}

export type TelegramInitDataFailure =
	| "malformed"
	| "bad_signature"
	| "expired"
	| "missing_user";

export type TelegramInitDataResult =
	| { ok: true; authDate: number; user: TelegramMiniAppUser }
	| { ok: false; reason: TelegramInitDataFailure };

export interface VerifyTelegramInitDataOptions {
	maxAgeSeconds?: number;
	/** Current time in milliseconds; injectable for tests. */
	now?: number;
}

function secretKey(botToken: string): Buffer {
	return createHmac("sha256", WEB_APP_DATA_KEY)
		.update(botToken, "utf8")
		.digest();
}

/** The sorted `key=value` lines Telegram signs (every field except `hash`). */
export function telegramDataCheckString(params: URLSearchParams): string {
	const lines: string[] = [];
	for (const [key, value] of params) {
		if (key !== "hash") {
			lines.push(`${key}=${value}`);
		}
	}
	return lines.sort().join("\n");
}

/** Sign launch parameters the way Telegram does. Used by tests and fixtures. */
export function signTelegramInitData(
	params: URLSearchParams,
	botToken: string
): string {
	return createHmac("sha256", secretKey(botToken))
		.update(telegramDataCheckString(params), "utf8")
		.digest("hex");
}

const telegramUserSchema = z.object({
	id: z
		.union([z.string(), z.number()])
		.transform(String)
		.refine((id) => TELEGRAM_USER_ID_RE.test(id)),
	username: z
		.string()
		.regex(TELEGRAM_USERNAME_RE)
		.transform((username) => username.toLowerCase())
		.nullable()
		.catch(null),
	first_name: z.string().min(1).nullable().catch(null),
});

function parseUser(raw: string | null): TelegramMiniAppUser | null {
	if (!raw) {
		return null;
	}
	try {
		const parsed = telegramUserSchema.safeParse(JSON.parse(raw));
		if (!parsed.success) {
			return null;
		}
		return {
			id: parsed.data.id,
			username: parsed.data.username,
			firstName: parsed.data.first_name,
		};
	} catch {
		return null;
	}
}

export function verifyTelegramInitData(
	initData: string,
	botToken: string,
	options: VerifyTelegramInitDataOptions = {}
): TelegramInitDataResult {
	if (
		!botToken ||
		initData.length === 0 ||
		initData.length > TELEGRAM_INIT_DATA_MAX_LENGTH
	) {
		return { ok: false, reason: "malformed" };
	}
	const params = new URLSearchParams(initData);
	const hash = params.get("hash")?.toLowerCase() ?? "";
	if (!TELEGRAM_HASH_RE.test(hash) || params.getAll("hash").length !== 1) {
		return { ok: false, reason: "malformed" };
	}

	const expected = Buffer.from(signTelegramInitData(params, botToken), "hex");
	const actual = Buffer.from(hash, "hex");
	if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
		return { ok: false, reason: "bad_signature" };
	}

	const authDate = Number(params.get("auth_date"));
	if (!Number.isSafeInteger(authDate) || authDate <= 0) {
		return { ok: false, reason: "malformed" };
	}
	const nowSeconds = Math.floor((options.now ?? Date.now()) / 1000);
	const maxAge = options.maxAgeSeconds ?? TELEGRAM_INIT_DATA_MAX_AGE_SECONDS;
	if (
		nowSeconds - authDate > maxAge ||
		authDate - nowSeconds > TELEGRAM_INIT_DATA_FUTURE_SKEW_SECONDS
	) {
		return { ok: false, reason: "expired" };
	}

	const user = parseUser(params.get("user"));
	if (!user) {
		return { ok: false, reason: "missing_user" };
	}
	return { authDate, ok: true, user };
}
