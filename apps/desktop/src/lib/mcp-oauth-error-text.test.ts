import { afterAll, describe, expect, test } from "bun:test";
import { formatMessage } from "@ryu/i18n/core";
import { ApiError } from "./api/client-api-error.ts";
import { confirmMcpOAuthFlow } from "./api/mcp-oauth.ts";
import {
	mcpOAuthErrorText,
	mcpOAuthRefusalCode,
} from "./mcp-oauth-error-text.ts";

// A stand-in German pack: the sentence the helper picks is what it shows.
const german: Record<string, string> = {
	"Couldn't connect {appName}.": "{appName} konnte nicht verbunden werden.",
	"The sign-in for {appName} expired. Connect it again.":
		"Die Anmeldung für {appName} ist abgelaufen. Verbinde es erneut.",
	"That code didn't match. Check the code your browser shows and try again.":
		"Dieser Code stimmt nicht.",
};
const germanTl = (source: string, values?: unknown) =>
	formatMessage(german[source] ?? `«${source}»`, values, "de");

const CODES = [
	"code_mismatch",
	"too_many_attempts",
	"expired",
	"cancelled",
	"not_awaiting",
	"issuer_mismatch",
	"missing_code",
	"invalid_state",
];

describe("mcpOAuthErrorText", () => {
	test("each code has its own translated sentence, never Core's English", () => {
		const sentences = CODES.map((code) =>
			mcpOAuthErrorText(code, "Mail", germanTl)
		);
		expect(new Set(sentences).size).toBe(CODES.length);
		expect(mcpOAuthErrorText("expired", "Mail", germanTl)).toBe(
			"Die Anmeldung für Mail ist abgelaufen. Verbinde es erneut."
		);
		expect(mcpOAuthErrorText("code_mismatch", "Mail", germanTl)).toBe(
			"Dieser Code stimmt nicht."
		);
		for (const sentence of sentences) {
			expect(sentence).not.toContain("OAuth");
		}
	});

	test("an unknown, protocol or missing code (older Core) is the generic sentence", () => {
		const generic = "Mail konnte nicht verbunden werden.";
		expect(mcpOAuthErrorText("protocol", "Mail", germanTl)).toBe(generic);
		expect(mcpOAuthErrorText("brand_new_code", "Mail", germanTl)).toBe(generic);
		expect(mcpOAuthErrorText(null, "Mail", germanTl)).toBe(generic);
		expect(mcpOAuthErrorText(undefined, "Mail")).toBe("Couldn't connect Mail.");
	});
});

describe("mcpOAuthRefusalCode", () => {
	test("reads Core's code, treats an older node's bare 400 as a wrong code", () => {
		expect(
			mcpOAuthRefusalCode(
				new ApiError("/confirm", 400, "Too many", "too_many_attempts")
			)
		).toBe("too_many_attempts");
		expect(
			mcpOAuthRefusalCode(
				new ApiError("/confirm", 400, "OAuth confirmation code did not match")
			)
		).toBe("code_mismatch");
		expect(mcpOAuthRefusalCode(new ApiError("/confirm", 404))).toBeNull();
		expect(mcpOAuthRefusalCode(new Error("offline"))).toBeNull();
	});
});

// End to end: Core's coded 400 body, through the real HTTP client, to a
// Japanese and an Arabic sentence (no Core English reaches the user).
const refusal = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch: () =>
		Response.json(
			{
				code: "too_many_attempts",
				error: "Too many incorrect confirmation codes",
			},
			{ status: 400 }
		),
});
afterAll(() => refusal.stop(true));

const packs: Record<string, Record<string, string>> = {
	ar: {
		"Too many incorrect codes. Connect {appName} again to get a new code.":
			"رموز غير صحيحة كثيرة. اربط {appName} مجددًا للحصول على رمز جديد.",
	},
	ja: {
		"Too many incorrect codes. Connect {appName} again to get a new code.":
			"誤ったコードが多すぎます。{appName} を再接続して新しいコードを取得してください。",
	},
};

describe("a refused confirmation end to end", () => {
	for (const locale of ["ja", "ar"]) {
		test(`is worded in ${locale}`, async () => {
			const error = await confirmMcpOAuthFlow(
				{ token: "t", url: refusal.url.toString() },
				"@ryu/mail",
				"f",
				"WRONG"
			).catch((caught: unknown) => caught);
			const localTl = (source: string, values?: unknown) =>
				formatMessage(packs[locale]?.[source] ?? source, values, locale);
			const sentence = mcpOAuthErrorText(
				mcpOAuthRefusalCode(error),
				"Mail",
				localTl
			);
			expect(sentence).toBe(
				formatMessage(
					packs[locale]?.[
						"Too many incorrect codes. Connect {appName} again to get a new code."
					] ?? "",
					{ appName: "Mail" },
					locale
				)
			);
			expect(sentence).toContain("Mail");
			expect(sentence).not.toContain("Too many");
		});
	}
});
