import { getCurrentAuthContextAsyncLocalStorage } from "@better-auth/core/context";
import {
	i18n as betterAuthI18n,
	locales as betterAuthLocales,
} from "@better-auth/i18n";
import {
	canonicalEmailLocale,
	configureRecipientLocaleResolver,
} from "@ryu/email/i18n/email-locale.ts";
import type { AuthContext, BetterAuthPlugin } from "better-auth";
import {
	isSelfServiceAuthRequest,
	LOCALE_COOKIE,
	resolveRecipientLocale,
	type StoredRecipient,
	scopeHeaders,
	signInLocaleUpdate,
	signUpLocale,
	userLocaleInputSchema,
} from "./recipient-locale.ts";

/**
 * Reviewed Better Auth locale dictionaries for authentication errors.
 * Community language packs intentionally remain outside this security-sensitive
 * response layer; their UI copy is handled by @ryu/i18n instead.
 */
export const RYU_AUTH_I18N_LOCALES = Object.freeze(
	Object.keys(betterAuthLocales)
);

async function storedLocaleFor(
	context: AuthContext,
	email: string
): Promise<StoredRecipient> {
	const user = await context.adapter.findOne<{ locale?: unknown }>({
		model: "user",
		where: [{ field: "email", value: email }],
	});
	return user ? { locale: user.locale ?? null } : null;
}

/**
 * The recipient-locale half of the plugin (lib/recipient-locale.ts): the
 * `user.locale` field, the sign-up/sign-in hooks that keep it current, and
 * the resolver `@ryu/email` uses for sends that name no locale.
 */
const recipientLocale = {
	schema: {
		user: {
			fields: {
				locale: {
					type: "string",
					required: false,
					input: true,
					validator: { input: userLocaleInputSchema },
					transform: { input: (value) => canonicalEmailLocale(value) },
				},
			},
		},
	},
	init: (context: AuthContext) => {
		configureRecipientLocaleResolver(async ({ to }) =>
			resolveRecipientLocale({
				scope: (await getCurrentAuthContextAsyncLocalStorage()).getStore(),
				storedLocale: (email) => storedLocaleFor(context, email),
				to,
			})
		);
		return {
			options: {
				databaseHooks: {
					user: {
						create: {
							before: async (
								user: Record<string, unknown>,
								ctx: Parameters<typeof scopeHeaders>[0]
							) => {
								const headers = isSelfServiceAuthRequest(ctx)
									? scopeHeaders(ctx)
									: null;
								const locale = signUpLocale(user.locale, headers);
								return locale ? { data: { locale } } : undefined;
							},
						},
					},
					session: {
						create: {
							after: async (
								session: { impersonatedBy?: unknown; userId: string },
								ctx: Parameters<typeof scopeHeaders>[0]
							) => {
								// An impersonation session is created inside the admin's
								// request; their language is not the account owner's.
								if (session.impersonatedBy || !isSelfServiceAuthRequest(ctx)) {
									return;
								}
								const headers = scopeHeaders(ctx);
								if (!headers) {
									return;
								}
								try {
									const user = await context.internalAdapter.findUserById(
										session.userId
									);
									if (!user || ("isAnonymous" in user && user.isAnonymous)) {
										return;
									}
									const locale = signInLocaleUpdate(
										"locale" in user ? user.locale : null,
										headers
									);
									if (locale) {
										await context.internalAdapter.updateUser(session.userId, {
											locale,
										});
									}
								} catch (error) {
									console.error("Failed to record the user's locale:", error);
								}
							},
						},
					},
				},
			},
		};
	},
} satisfies Pick<BetterAuthPlugin, "init" | "schema">;

export type RyuAuthI18nPlugin = ReturnType<typeof betterAuthI18n> &
	typeof recipientLocale;

export function createRyuAuthI18nPlugin(): RyuAuthI18nPlugin {
	return {
		...betterAuthI18n({
			translations: betterAuthLocales,
			detection: ["cookie", "header"],
			defaultLocale: "en",
			localeCookie: LOCALE_COOKIE,
		}),
		...recipientLocale,
	};
}
