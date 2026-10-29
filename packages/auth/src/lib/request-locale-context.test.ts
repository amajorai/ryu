import { describe, expect, it } from "bun:test";
import { resolveRecipientLocale } from "./recipient-locale.ts";
import {
	currentRequestLocaleScope,
	runWithRequestLocale,
	setRequestLocaleRequester,
} from "./request-locale-context.ts";

const headers = (init: Record<string, string>) => new Headers(init);
const stored =
	(table: Record<string, string | null>) =>
	(email: string): Promise<{ locale: unknown } | null> =>
		Promise.resolve(email in table ? { locale: table[email] } : null);

describe("request locale context", () => {
	it("is empty outside an API request", () => {
		expect(currentRequestLocaleScope()).toBeNull();
		setRequestLocaleRequester("ada@example.com");
		expect(currentRequestLocaleScope()).toBeNull();
	});

	it("writes to an address without an account in the request's language", async () => {
		const locale = await runWithRequestLocale(
			headers({ "accept-language": "de-DE,de;q=0.9" }),
			() =>
				resolveRecipientLocale({
					scope: undefined,
					storedLocale: stored({}),
					to: "new-address@example.com",
				})
		);
		expect(locale).toBe("de-DE");
	});

	it("prefers the locale cookie over Accept-Language", async () => {
		const locale = await runWithRequestLocale(
			headers({ "accept-language": "de-DE", cookie: "locale=ja" }),
			() =>
				resolveRecipientLocale({
					scope: undefined,
					storedLocale: stored({}),
					to: "invitee@example.com",
				})
		);
		expect(locale).toBe("ja");
	});

	it("gives the signed-in requester the language they picked over a stored one", async () => {
		const locale = await runWithRequestLocale(
			headers({ cookie: "locale=ja" }),
			async () => {
				setRequestLocaleRequester("Ada@Example.com");
				await Promise.resolve();
				return resolveRecipientLocale({
					scope: undefined,
					storedLocale: stored({ "ada@example.com": "fr" }),
					to: "ada@example.com",
				});
			}
		);
		expect(locale).toBe("ja");
	});

	it("keeps the requester's stored locale over a browser default", async () => {
		const locale = await runWithRequestLocale(
			headers({ "accept-language": "de-DE" }),
			() => {
				setRequestLocaleRequester("ada@example.com");
				return resolveRecipientLocale({
					scope: undefined,
					storedLocale: stored({ "ada@example.com": "fr" }),
					to: "ada@example.com",
				});
			}
		);
		expect(locale).toBe("fr");
	});

	it("never gives another existing account the requester's language", async () => {
		const resolve = (table: Record<string, string | null>) =>
			runWithRequestLocale(headers({ cookie: "locale=ja" }), () => {
				setRequestLocaleRequester("ada@example.com");
				return resolveRecipientLocale({
					scope: undefined,
					storedLocale: stored(table),
					to: "grace@example.com",
				});
			});
		expect(await resolve({ "grace@example.com": "fr" })).toBe("fr");
		expect(await resolve({ "grace@example.com": null })).toBeNull();
	});

	it("does not treat an unnamed request as the recipient's own", async () => {
		const locale = await runWithRequestLocale(
			headers({ cookie: "locale=ja" }),
			() =>
				resolveRecipientLocale({
					scope: undefined,
					storedLocale: stored({ "ada@example.com": null }),
					to: "ada@example.com",
				})
		);
		expect(locale).toBeNull();
	});

	it("lets a Better Auth request's own headers win", async () => {
		const locale = await runWithRequestLocale(
			headers({ cookie: "locale=ja" }),
			() =>
				resolveRecipientLocale({
					scope: { headers: headers({ cookie: "locale=fr" }) },
					storedLocale: stored({}),
					to: "invitee@example.com",
				})
		);
		expect(locale).toBe("fr");
	});

	it("falls back to the API request for a Better Auth call without headers", async () => {
		const locale = await runWithRequestLocale(
			headers({ cookie: "locale=ja" }),
			() =>
				resolveRecipientLocale({
					scope: { headers: undefined },
					storedLocale: stored({}),
					to: "invitee@example.com",
				})
		);
		expect(locale).toBe("ja");
	});
});
