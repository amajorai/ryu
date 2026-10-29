import { afterEach, describe, expect, it } from "bun:test";
import {
	configureRecipientLocaleResolver,
	resolveEmailLocale,
} from "@ryu/email/i18n/email-locale.ts";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { APIError, createAuthEndpoint } from "better-auth/api";
import { admin } from "better-auth/plugins";
import { createRyuAuthI18nPlugin, RYU_AUTH_I18N_LOCALES } from "./auth-i18n.ts";
import type { AuthFixtureDatabase } from "./auth-test-fixtures.ts";

describe("Ryu Better Auth i18n configuration", () => {
	it("uses the reviewed built-in locale dictionaries", () => {
		const plugin = createRyuAuthI18nPlugin();

		expect(plugin.id).toBe("i18n");
		expect(RYU_AUTH_I18N_LOCALES).toContain("en");
		expect(RYU_AUTH_I18N_LOCALES).toContain("fr");
		expect(RYU_AUTH_I18N_LOCALES.length).toBe(22);
		expect(plugin.options.defaultLocale).toBe("en");
		expect(plugin.options.detection).toEqual(["cookie", "header"]);
		expect(plugin.options.localeCookie).toBe("locale");
	});

	it("translates auth errors and preserves the original message", async () => {
		const plugin = createRyuAuthI18nPlugin();
		const original = new APIError("BAD_REQUEST", {
			code: "INVALID_PASSWORD",
			message: "Invalid password",
		});

		const database: Pick<
			AuthFixtureDatabase,
			"user" | "session" | "account" | "verification"
		> = { user: [], session: [], account: [], verification: [] };
		const auth = betterAuth({
			baseURL: "http://localhost:3000",
			secret: "auth-i18n-fixture-at-least-32-characters",
			database: memoryAdapter(database),
			plugins: [
				plugin,
				{
					id: "i18n-error-fixture",
					endpoints: {
						i18nErrorFixture: createAuthEndpoint(
							"/i18n-error-fixture",
							{ method: "GET" },
							() => {
								throw original;
							}
						),
					},
				},
			],
		});
		let responseError: APIError | null = null;
		try {
			await auth.api.i18nErrorFixture({
				headers: new Headers({ Cookie: "locale=fr" }),
			});
		} catch (error) {
			if (!(error instanceof APIError)) {
				throw error;
			}
			responseError = error;
		}
		if (!responseError) {
			throw new Error("Expected translated API error");
		}
		expect(responseError).toBeInstanceOf(APIError);
		expect(responseError.message).toBe("Mot de passe invalide");
		expect(responseError.body).toMatchObject({
			code: "INVALID_PASSWORD",
			originalMessage: "Invalid password",
		});
	});
});

describe("recipient locale", () => {
	afterEach(() => {
		configureRecipientLocaleResolver(null);
	});

	function localeAuth(withAdmin = false) {
		const database: Pick<
			AuthFixtureDatabase,
			"user" | "session" | "account" | "verification"
		> = { user: [], session: [], account: [], verification: [] };
		const auth = betterAuth({
			baseURL: "http://localhost:3000",
			secret: "auth-i18n-fixture-at-least-32-characters",
			database: memoryAdapter(database),
			emailAndPassword: { enabled: true },
			plugins: withAdmin
				? [createRyuAuthI18nPlugin(), admin()]
				: [createRyuAuthI18nPlugin()],
		});
		const storedLocale = (email: string): unknown => {
			const user = database.user.find((row) => row.email === email);
			return user && "locale" in user ? user.locale : undefined;
		};
		return { auth, database, storedLocale };
	}

	it("stores the sign-up language, follows a picked language on sign-in, and resolves it for email", async () => {
		const { auth, storedLocale } = localeAuth();
		await auth.api.signUpEmail({
			body: {
				email: "ada@example.com",
				name: "Ada",
				password: "correct horse battery staple",
			},
			headers: new Headers({ "accept-language": "fr-FR,fr;q=0.9" }),
		});
		expect(storedLocale("ada@example.com")).toBe("fr-FR");

		await auth.api.signInEmail({
			body: {
				email: "ada@example.com",
				password: "correct horse battery staple",
			},
			headers: new Headers({ "accept-language": "en", cookie: "locale=de" }),
		});
		expect(storedLocale("ada@example.com")).toBe("de");

		expect(await resolveEmailLocale({ to: "Ada@example.com" })).toBe("de");
		expect(await resolveEmailLocale({ to: "nobody@example.com" })).toBe("en");
	});

	it("saves a language change through update-user and refuses junk", async () => {
		const { auth, storedLocale } = localeAuth();
		const signedUp = await auth.api.signUpEmail({
			body: {
				email: "grace@example.com",
				name: "Grace",
				password: "correct horse battery staple",
			},
			returnHeaders: true,
		});
		const cookie = signedUp.headers.get("set-cookie") ?? "";
		const session = new Headers({ cookie: cookie.split(";")[0] ?? "" });
		await auth.api.updateUser({ body: { locale: "ja" }, headers: session });
		expect(storedLocale("grace@example.com")).toBe("ja");
		await expect(
			auth.api.updateUser({ body: { locale: "ja, en" }, headers: session })
		).rejects.toThrow();
		expect(storedLocale("grace@example.com")).toBe("ja");
	});

	it("keeps an admin's language off accounts they create or impersonate", async () => {
		const { auth, database, storedLocale } = localeAuth(true);
		const signedUp = await auth.api.signUpEmail({
			body: {
				email: "root@example.com",
				name: "Root",
				password: "correct horse battery staple",
			},
			headers: new Headers({ cookie: "locale=de" }),
			returnHeaders: true,
		});
		for (const row of database.user) {
			if (row.email === "root@example.com") {
				Object.assign(row, { role: "admin" });
			}
		}
		const adminCookie = (signedUp.headers.get("set-cookie") ?? "").split(
			";"
		)[0];
		const adminHeaders = new Headers({
			"accept-language": "de",
			cookie: `${adminCookie}; locale=de`,
		});
		const created = await auth.api.createUser({
			body: {
				email: "target@example.com",
				name: "Target",
				password: "correct horse battery staple",
			},
			headers: adminHeaders,
		});
		expect(storedLocale("target@example.com") ?? null).toBeNull();

		await auth.api.impersonateUser({
			body: { userId: created.user.id },
			headers: adminHeaders,
		});
		expect(storedLocale("target@example.com") ?? null).toBeNull();
		expect(await resolveEmailLocale({ to: "target@example.com" })).toBe("en");
	});
});
