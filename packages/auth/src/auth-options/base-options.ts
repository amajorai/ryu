import { client, mongoClient } from "@ryu/db";
import { env } from "@ryu/env/server";
import type { BetterAuthOptions } from "better-auth";
import { sessionCookieCache } from "../lib/session-cache.ts";
import { ACCOUNT_LINKING_SOCIAL_PROVIDER_IDS } from "../lib/social-provider-policy.ts";
import { validateSsoIdentityUserInfo } from "../lib/sso-email-domain.ts";
import { encryptedMongoAdapter } from "../lib/sso-provider-encryption.ts";

import { releaseReservationsOfFailedInvitationWrites } from "./invitation-emails.ts";
import {
	parseCorsOrigins,
	parseCsvEnv,
	resolveAuthCookieDomain,
} from "./origins.ts";

// Session, storage, rate limit, social provider, user and cookie options.

export const baseAuthOptions = {
	session: { cookieCache: sessionCookieCache },
	// Identifiers that embed a bearer token (password reset, account deletion)
	// are stored as SHA-256 digests, so a database dump cannot complete a reset.
	// Email-keyed OTP identifiers stay plain on purpose: their values are
	// already encrypted (`storeOTP: "encrypted"`), and account merge deletes the
	// absorbed address's rows by matching the email in the identifier.
	verification: {
		storeIdentifier: {
			default: "plain",
			overrides: {
				"delete-account-": "hashed",
				"reset-password:": "hashed",
			},
		},
	},
	// SCIM creates/updates a user and its SCIM source records, and removes the
	// organization membership on deprovisioning, as one operation. Pass the native MongoClient so Better Auth enables interactive
	// transactions; passing only the Db silently disables the transaction hook.
	database: releaseReservationsOfFailedInvitationWrites(
		encryptedMongoAdapter(client, { client: mongoClient })
	),
	trustedOrigins: parseCorsOrigins(),
	appName: "Ryu",
	// Better Auth reads BETTER_AUTH_SECRETS automatically when present. Keep the
	// scalar secret for backwards compatibility with deployments and Ryu code
	// that still reads BETTER_AUTH_SECRET directly; the versioned list takes
	// precedence for Better Auth signing and verification.
	secret: env.BETTER_AUTH_SECRET,
	baseURL: env.BETTER_AUTH_URL,
	rateLimit: {
		enabled: true,
		window: 60,
		max: 100,
		storage: "database",
		customRules: {
			"/oauth2/token": { window: 60, max: 30 },
			"/oauth2/register": { window: 60, max: 10 },
			"/device/code": { window: 60, max: 10 },
			"/device/token": { window: 60, max: 10 },
			"/device/approve": { window: 60, max: 10 },
			"/device/deny": { window: 60, max: 10 },
			"/scim/v2/*": { window: 60, max: 120 },
		},
	},
	socialProviders: (() => {
		const providers: NonNullable<BetterAuthOptions["socialProviders"]> = {
			google: {
				clientId: env.GOOGLE_CLIENT_ID ?? "",
				clientSecret: env.GOOGLE_CLIENT_SECRET ?? "",
			},
		};
		if (env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET) {
			providers.github = {
				clientId: env.GITHUB_CLIENT_ID,
				clientSecret: env.GITHUB_CLIENT_SECRET,
			};
		}
		if (env.DISCORD_CLIENT_ID && env.DISCORD_CLIENT_SECRET) {
			providers.discord = {
				clientId: env.DISCORD_CLIENT_ID,
				clientSecret: env.DISCORD_CLIENT_SECRET,
			};
		}
		return providers;
	})(),
	account: {
		accountLinking: {
			enabled: true,
			trustedProviders: [...ACCOUNT_LINKING_SOCIAL_PROVIDER_IDS],
			allowUnlinkingAll: true,
		},
	},
	user: {
		// Better Auth calls this before it creates a user, links a provider
		// account, or signs a provider user in. SSO identities must stay on the
		// provider's DNS-verified domain (asserted and stored address alike), so
		// an organization cannot pre-register or take over an address it does
		// not own (lib/sso-email-domain.ts). Other sources pass through.
		validateUserInfo: validateSsoIdentityUserInfo,
		additionalFields: {
			// Match the twoFactor plugin's server-owned field in the canonical
			// options so getSession inference retains the existing enrollment state.
			twoFactorEnabled: {
				type: "boolean",
				required: false,
				defaultValue: false,
				input: false,
			},
			avatarId: {
				type: "string",
				required: false,
				input: false,
			},
			resendContactId: {
				type: "string",
				input: false,
			},
			emailVerifiedAt: {
				type: "date",
				input: false,
			},
			lastEmailSentAt: {
				type: "date",
				input: false,
			},
			dailyEmailCount: {
				type: "number",
				input: false,
			},
			lastEmailResetDate: {
				type: "date",
				input: false,
			},
			// Referral. `referralCode` and `referralCount` are server-managed
			// (input:false). `referredBy` is the only one accepted from the sign-up
			// request: the referral code the new user arrived with (from a `?ref=`
			// share link). `/update-user` may not write it afterwards
			// (`rejectReferredByUpdate` in the global before hook), so attribution
			// stays fixed at sign-up. The waitlist rides the admin-plugin `role` field.
			referralCode: {
				type: "string",
				input: false,
			},
			referredBy: {
				type: "string",
				input: true,
				required: false,
			},
			referralCount: {
				type: "number",
				input: false,
			},
			profileVisibility: {
				type: "string",
				input: false,
				defaultValue: "public",
			},
		},
	},
	advanced: (() => {
		const authCookieDomain = resolveAuthCookieDomain();
		const ipAddressHeaders = parseCsvEnv(env.BETTER_AUTH_IP_ADDRESS_HEADERS);
		const trustedProxies = parseCsvEnv(env.BETTER_AUTH_TRUSTED_PROXIES);
		const ipAddress: NonNullable<
			NonNullable<BetterAuthOptions["advanced"]>["ipAddress"]
		> = {
			// Trust one forwarded value unless explicit proxy ranges are configured.
			ipAddressHeaders:
				ipAddressHeaders.length > 0 ? ipAddressHeaders : ["x-forwarded-for"],
		};
		if (trustedProxies.length > 0) {
			ipAddress.trustedProxies = trustedProxies;
		}
		const advanced: NonNullable<BetterAuthOptions["advanced"]> = {
			ipAddress,
			defaultCookieAttributes: {
				sameSite: "lax",
				secure: process.env.NODE_ENV === "production",
				httpOnly: true,
			},
		};
		// Sharing the cookie domain keeps apex/subdomain SSR session checks aligned.
		if (authCookieDomain) {
			advanced.crossSubDomainCookies = {
				enabled: true,
				domain: authCookieDomain,
			};
		}
		return advanced;
	})(),
} satisfies Partial<BetterAuthOptions>;
