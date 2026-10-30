import { afterEach, describe, expect, it } from "bun:test";
import {
	configureRecipientLocaleResolver,
	resolveEmailLocale,
} from "@ryu/email/i18n/email-locale.ts";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { APIError, createAuthEndpoint } from "better-auth/api";
import { admin } from "better-auth/plugins";
import {
	authErrorLocale,
	createRyuAuthI18nPlugin,
	RYU_AUTH_I18N_LOCALES,
} from "./auth-i18n.ts";
import type { AuthFixtureDatabase } from "./auth-test-fixtures.ts";

// `OFFICIAL_CATALOG_LOCALES` in @ryu/i18n (not a dependency of this package).
const OFFICIAL_APP_LOCALES = [
	"ar",
	"de",
	"es",
	"fr",
	"hi",
	"it",
	"ja",
	"ko",
	"pt-BR",
	"ru",
	"zh-CN",
];

async function translatedAuthError(headers: Headers): Promise<APIError> {
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
			createRyuAuthI18nPlugin(),
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
	try {
		await auth.api.i18nErrorFixture({ headers });
	} catch (error) {
		if (error instanceof APIError) {
			return error;
		}
		throw error;
	}
	throw new Error("Expected translated API error");
}

describe("Ryu Better Auth i18n configuration", () => {
	it("uses the reviewed built-in locale dictionaries", () => {
		const plugin = createRyuAuthI18nPlugin();

		expect(plugin.id).toBe("i18n");
		expect(RYU_AUTH_I18N_LOCALES).toContain("en");
		expect(RYU_AUTH_I18N_LOCALES).toContain("fr");
		expect(RYU_AUTH_I18N_LOCALES.length).toBe(22);
		expect(plugin.options.defaultLocale).toBe("en");
		expect(plugin.options.detection).toEqual(["callback"]);
		expect(plugin.options.localeCookie).toBe("locale");
	});

	it("covers every official app locale with a dictionary", () => {
		for (const locale of [...OFFICIAL_APP_LOCALES, "en"]) {
			expect(
				authErrorLocale(new Headers({ cookie: `locale=${locale}` }))
			).not.toBeNull();
		}
	});

	it("maps regional cookies and headers onto the dictionary keys", () => {
		const detect = (init: Record<string, string>) =>
			authErrorLocale(new Headers(init));
		expect(detect({ cookie: "locale=pt-BR", "accept-language": "de" })).toBe(
			"pt"
		);
		expect(detect({ cookie: "locale=zh-CN", "accept-language": "de" })).toBe(
			"zh"
		);
		expect(detect({ cookie: "locale=nl" })).toBe("nl");
		expect(detect({ "accept-language": "pt-BR,pt;q=0.9" })).toBe("pt");
		expect(detect({ "accept-language": "zh-TW" })).toBeNull();
	});

	it("uses a signed-in account's stored locale when no cookie picks one", () => {
		const headers = new Headers({ "accept-language": "de" });
		expect(authErrorLocale(headers, "pt-BR")).toBe("pt");
		expect(authErrorLocale(headers, "zh-CN")).toBe("zh");
		expect(authErrorLocale(headers, null)).toBe("de");
		expect(authErrorLocale(new Headers({ cookie: "locale=ja" }), "pt-BR")).toBe(
			"ja"
		);
	});

	it("translates auth errors and preserves the original message", async () => {
		const responseError = await translatedAuthError(
			new Headers({ Cookie: "locale=fr" })
		);
		expect(responseError.message).toBe("Mot de passe invalide");
		expect(responseError.body).toMatchObject({
			code: "INVALID_PASSWORD",
			originalMessage: "Invalid password",
		});
	});

	it("translates for the app's regional pt-BR and zh-CN cookies", async () => {
		const portuguese = await translatedAuthError(
			new Headers({ Cookie: "locale=pt-BR", "Accept-Language": "en" })
		);
		expect(portuguese.message).toBe("Senha inválida");
		const chinese = await translatedAuthError(
			new Headers({ Cookie: "locale=zh-CN", "Accept-Language": "en" })
		);
		expect(chinese.message).toBe("密码无效");
	});

	it("keeps English when nothing the request asks for is covered", async () => {
		const error = await translatedAuthError(
			new Headers({ "Accept-Language": "zh-TW" })
		);
		expect(error.message).toBe("Invalid password");
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
