import { describe, expect, it } from "bun:test";
import { APIError } from "better-auth/api";
import { createRyuAuthI18nPlugin, RYU_AUTH_I18N_LOCALES } from "./auth-i18n.ts";

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

		let thrown: unknown;
		try {
			await plugin.hooks.after[0].handler({
				headers: new Headers({ Cookie: "locale=fr" }),
				context: { returned: original },
			} as never);
		} catch (error) {
			thrown = error;
		}

		const responseError = thrown as {
			body?: { code?: unknown; originalMessage?: unknown };
			message?: unknown;
		};
		expect(responseError).toBeInstanceOf(APIError);
		expect(responseError.message).toBe("Mot de passe invalide");
		expect(responseError.body).toMatchObject({
			code: "INVALID_PASSWORD",
			originalMessage: "Invalid password",
		});
	});
});
