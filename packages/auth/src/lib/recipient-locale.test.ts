import { describe, expect, it } from "bun:test";
import {
	isSelfServiceAuthRequest,
	requestLocales,
	resolveRecipientLocale,
	signInLocaleUpdate,
	signUpLocale,
	userLocaleInputSchema,
} from "./recipient-locale.ts";

const headers = (init: Record<string, string>) => new Headers(init);

describe("requestLocales", () => {
	it("reads the locale cookie and Accept-Language separately", () => {
		expect(
			requestLocales(
				headers({
					"accept-language": "de-DE,de;q=0.9,en;q=0.5",
					cookie: "theme=dark; locale=pt-br",
				})
			)
		).toEqual({ accepted: "de-DE", chosen: "pt-BR" });
	});

	it("skips Accept-Language entries email cannot render", () => {
		expect(
			requestLocales(headers({ "accept-language": "nl,zh-TW;q=0.9,fr;q=0.8" }))
				.accepted
		).toBe("fr");
		expect(
			requestLocales(headers({ "accept-language": "nl, zh-TW" })).accepted
		).toBeNull();
		expect(
			signInLocaleUpdate(null, headers({ "accept-language": "nl" }))
		).toBeNull();
	});

	it("ignores a malformed cookie and a missing header", () => {
		expect(requestLocales(headers({ cookie: "locale=%E0%A4%A" }))).toEqual({
			accepted: null,
			chosen: null,
		});
		expect(requestLocales(null)).toEqual({ accepted: null, chosen: null });
	});
});

describe("resolveRecipientLocale", () => {
	const stored =
		(table: Record<string, string | null>) =>
		(email: string): Promise<{ locale: unknown } | null> =>
			Promise.resolve(email in table ? { locale: table[email] } : null);
	const session = (email: string) => ({ session: { user: { email } } });

	it("gives the signed-in requester the language they picked", async () => {
		expect(
			await resolveRecipientLocale({
				scope: {
					context: session("Ada@Example.com"),
					headers: headers({ cookie: "locale=ja" }),
				},
				storedLocale: stored({ "ada@example.com": "fr" }),
				to: "ada@example.com",
			})
		).toBe("ja");
	});

	it("does not let an unauthenticated body override a stored locale", async () => {
		expect(
			await resolveRecipientLocale({
				scope: {
					body: { email: "ada@example.com" },
					headers: headers({ cookie: "locale=ja" }),
				},
				storedLocale: stored({ "ada@example.com": "fr" }),
				to: "ada@example.com",
			})
		).toBe("fr");
	});

	it("uses the request's language for a named address with nothing stored", async () => {
		expect(
			await resolveRecipientLocale({
				scope: {
					body: { email: "ada@example.com" },
					headers: headers({ "accept-language": "es-MX" }),
				},
				storedLocale: stored({ "ada@example.com": null }),
				to: "ada@example.com",
			})
		).toBe("es-MX");
	});

	it("prefers a stored locale over a browser default", async () => {
		expect(
			await resolveRecipientLocale({
				scope: {
					context: session("ada@example.com"),
					headers: headers({ "accept-language": "en-US" }),
				},
				storedLocale: stored({ "ada@example.com": "fr" }),
				to: "ada@example.com",
			})
		).toBe("fr");
	});

	it("writes to someone else in their own stored language", async () => {
		expect(
			await resolveRecipientLocale({
				scope: {
					context: session("owner@example.com"),
					headers: headers({ cookie: "locale=es" }),
				},
				storedLocale: stored({ "member@example.com": "ko" }),
				to: "member@example.com",
			})
		).toBe("ko");
	});

	it("never gives an existing account the actor's language", async () => {
		expect(
			await resolveRecipientLocale({
				scope: {
					context: session("owner@example.com"),
					headers: headers({ "accept-language": "it", cookie: "locale=es" }),
				},
				storedLocale: stored({ "member@example.com": null }),
				to: "member@example.com",
			})
		).toBeNull();
	});

	it("writes to an invitee without an account in the inviter's language", async () => {
		expect(
			await resolveRecipientLocale({
				scope: {
					context: session("owner@example.com"),
					headers: headers({ "accept-language": "it" }),
				},
				storedLocale: stored({}),
				to: "new@example.com",
			})
		).toBe("it");
	});

	it("uses the stored locale outside a request and null when unknown", async () => {
		const lookup = stored({ "ada@example.com": "zh-cn" });
		expect(
			await resolveRecipientLocale({
				scope: null,
				storedLocale: lookup,
				to: "ada@example.com",
			})
		).toBe("zh-CN");
		expect(
			await resolveRecipientLocale({
				scope: undefined,
				storedLocale: lookup,
				to: "other@example.com",
			})
		).toBeNull();
	});
});

describe("isSelfServiceAuthRequest", () => {
	it("accepts sign-up, sign-in and callbacks only", () => {
		expect(isSelfServiceAuthRequest({ path: "/sign-up/email" })).toBe(true);
		expect(isSelfServiceAuthRequest({ path: "/sign-in/email-otp" })).toBe(true);
		expect(isSelfServiceAuthRequest({ path: "/callback/:id" })).toBe(true);
		expect(isSelfServiceAuthRequest({ path: "/magic-link/verify" })).toBe(true);
		expect(isSelfServiceAuthRequest({ path: "/admin/create-user" })).toBe(
			false
		);
		expect(isSelfServiceAuthRequest({ path: "/admin/impersonate-user" })).toBe(
			false
		);
		expect(isSelfServiceAuthRequest({ path: "/update-user" })).toBe(false);
		expect(isSelfServiceAuthRequest(null)).toBe(false);
	});
});

describe("stored locale updates", () => {
	it("stores the sign-up request's language", () => {
		expect(signUpLocale(undefined, headers({ cookie: "locale=ar" }))).toBe(
			"ar"
		);
		expect(
			signUpLocale(undefined, headers({ "accept-language": "hi-IN" }))
		).toBe("hi-IN");
		expect(signUpLocale("ru", headers({ cookie: "locale=ar" }))).toBe("ru");
		expect(signUpLocale(undefined, null)).toBeNull();
	});

	it("lets a picked language replace the stored one on sign-in", () => {
		expect(signInLocaleUpdate("fr", headers({ cookie: "locale=de" }))).toBe(
			"de"
		);
		expect(
			signInLocaleUpdate("de", headers({ cookie: "locale=de" }))
		).toBeNull();
	});

	it("lets a browser default only fill an empty locale", () => {
		expect(
			signInLocaleUpdate("fr", headers({ "accept-language": "en" }))
		).toBeNull();
		expect(signInLocaleUpdate(null, headers({ "accept-language": "es" }))).toBe(
			"es"
		);
	});
});

describe("userLocaleInputSchema", () => {
	it("accepts one tag or a clear, and rejects anything else", () => {
		expect(userLocaleInputSchema.safeParse("pt-BR").success).toBe(true);
		expect(userLocaleInputSchema.safeParse(null).success).toBe(true);
		expect(userLocaleInputSchema.safeParse("fr,de").success).toBe(false);
		expect(userLocaleInputSchema.safeParse("<script>").success).toBe(false);
	});
});
