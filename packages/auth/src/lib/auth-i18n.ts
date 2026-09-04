import {
	i18n as betterAuthI18n,
	locales as betterAuthLocales,
} from "@better-auth/i18n";

/**
 * Reviewed Better Auth locale dictionaries for authentication errors.
 * Community language packs intentionally remain outside this security-sensitive
 * response layer; their UI copy is handled by @ryu/i18n instead.
 */
export const RYU_AUTH_I18N_LOCALES = Object.freeze(
	Object.keys(betterAuthLocales)
);

export function createRyuAuthI18nPlugin() {
	return betterAuthI18n({
		translations: betterAuthLocales,
		detection: ["cookie", "header"],
		defaultLocale: "en",
		localeCookie: "locale",
	});
}
