import { apiKey } from "@better-auth/api-key";
import { expo } from "@better-auth/expo";
import { checkout, polar, portal } from "@polar-sh/better-auth";
import { client } from "@ryu/db";
import { User } from "@ryu/db/models/auth.model";
import { Member } from "@ryu/db/models/control-plane.model";
import {
	configureContactIdSaver,
	configureRateLimiting,
	MagicLinkEmail,
	OrganizationInvitationEmail,
	PasswordChangeEmail,
	PasswordResetEmail,
	type RateLimitResult,
	SignInOTPEmail,
	sendEmail,
	subscribeContact,
	TwoFactorOTPEmail,
	VerificationEmail,
	WaitlistConfirmationEmail,
} from "@ryu/email";
import { env } from "@ryu/env/server";
import { betterAuth } from "better-auth";
import { mongodbAdapter } from "better-auth/adapters/mongodb";
import {
	APIError,
	createAuthEndpoint,
	createAuthMiddleware,
} from "better-auth/api";
import {
	bearer,
	captcha,
	deviceAuthorization,
	emailOTP,
	lastLoginMethod,
	magicLink,
	mcp,
	multiSession,
	organization,
	twoFactor,
	username,
} from "better-auth/plugins";
import { admin } from "better-auth/plugins/admin";
import { jwt } from "better-auth/plugins/jwt";
import { oidcProvider } from "better-auth/plugins/oidc-provider";
import { POLAR_PRODUCTS } from "./lib/constants.ts";
import { TAURI_DESKTOP_ORIGINS } from "./lib/cors-origins.ts";
import {
	ensurePersonalOrganization,
	type OrganizationApi,
} from "./lib/organizations.ts";
import {
	ensurePolarCustomer,
	polarClient,
	syncPolarCustomer,
} from "./lib/payments.ts";
import {
	ADMIN_ROLE,
	APPROVED_ROLE,
	generateReferralCode,
	isAdminEmail,
	isWaitlistBypassed,
	referralUrlFor,
	WAITLIST_ROLE,
	webOrigin,
} from "./lib/waitlist.ts";
import { waitlistPositionFor } from "./lib/waitlist-queue.ts";
import { defaultPermissionsForRole, RYU_SUPPORTED_SCOPES } from "./scopes.ts";

// Narrow an unknown caught error to its string `code` (e.g. better-auth's
// RATE_LIMIT_EXCEEDED) without an `as any` cast.
const errorCode = (e: unknown): string | undefined =>
	typeof e === "object" && e !== null && "code" in e
		? String((e as { code: unknown }).code)
		: undefined;

interface EmailUser {
	email: string;
	name?: string | null;
}

interface AuthAccount {
	providerId: string;
}

interface RateLimitedError {
	retryAfter?: number;
}

const TURNSTILE_SECRET_KEY = process.env.TURNSTILE_SECRET_KEY ?? "";

function retryAfterSeconds(error: unknown): number | undefined {
	if (typeof error !== "object" || error === null || !("retryAfter" in error)) {
		return;
	}
	const { retryAfter } = error as RateLimitedError;
	return typeof retryAfter === "number" ? retryAfter : undefined;
}

const checkEmailRateLimit = async (email: string): Promise<RateLimitResult> => {
	try {
		const user = await User.findOne({ email: email.toLowerCase() });

		if (!user) {
			return { allowed: true };
		}

		const now = new Date();

		if (user.lastEmailSentAt) {
			const timeSinceLastEmail = now.getTime() - user.lastEmailSentAt.getTime();
			const cooldownPeriod = 60 * 1000;

			if (timeSinceLastEmail < cooldownPeriod) {
				const retryAfter = Math.ceil(
					(cooldownPeriod - timeSinceLastEmail) / 1000
				);
				return {
					allowed: false,
					reason: "Please wait before requesting another email",
					retryAfter,
				};
			}
		}

		const today = new Date();
		today.setHours(0, 0, 0, 0);

		if (user.lastEmailResetDate) {
			const lastReset = new Date(user.lastEmailResetDate);
			lastReset.setHours(0, 0, 0, 0);

			if (today.getTime() > lastReset.getTime()) {
				await User.updateOne(
					{ _id: user._id },
					{ $set: { dailyEmailCount: 0, lastEmailResetDate: today } }
				);
			}
		} else {
			await User.updateOne(
				{ _id: user._id },
				{ $set: { lastEmailResetDate: today } }
			);
		}

		if ((user.dailyEmailCount ?? 0) >= 20) {
			const tomorrow = new Date(today);
			tomorrow.setDate(tomorrow.getDate() + 1);
			const retryAfter = Math.ceil((tomorrow.getTime() - now.getTime()) / 1000);

			return {
				allowed: false,
				reason:
					"You have reached the daily email limit. Please try again tomorrow",
				retryAfter,
			};
		}

		return { allowed: true };
	} catch (error) {
		console.error("Error checking email rate limit:", error);
		return { allowed: true };
	}
};

const updateEmailStats = async (email: string): Promise<void> => {
	try {
		const user = await User.findOne({ email: email.toLowerCase() });

		if (!user) {
			return;
		}

		const now = new Date();
		const today = new Date();
		today.setHours(0, 0, 0, 0);

		let newDailyCount: number;
		let newResetDate: Date | undefined;

		if (user.lastEmailResetDate) {
			const lastReset = new Date(user.lastEmailResetDate);
			lastReset.setHours(0, 0, 0, 0);

			if (today.getTime() > lastReset.getTime()) {
				newDailyCount = 1;
				newResetDate = today;
			} else {
				newDailyCount = (user.dailyEmailCount ?? 0) + 1;
			}
		} else {
			newDailyCount = 1;
			newResetDate = today;
		}

		await User.updateOne(
			{ _id: user._id },
			{
				$set: {
					lastEmailSentAt: now,
					dailyEmailCount: newDailyCount,
					...(newResetDate && { lastEmailResetDate: newResetDate }),
				},
			}
		);
	} catch (error) {
		console.error("Error updating user email stats:", error);
	}
};

configureRateLimiting(checkEmailRateLimit, updateEmailStats);

const saveContactIdToUser = async (
	email: string,
	contactId: string
): Promise<void> => {
	try {
		const user = await User.findOne({ email: email.toLowerCase() });
		if (!user) {
			return;
		}
		if (!user.resendContactId) {
			await User.updateOne(
				{ _id: user._id },
				{ $set: { resendContactId: contactId } }
			);
		}
	} catch (error) {
		console.error("Error saving contact ID to user:", error);
	}
};

configureContactIdSaver(saveContactIdToUser);

// The browser extension's pages (dashboard.html, popup) run on a fixed
// chrome-extension:// origin and call Better Auth directly (device-auth flow,
// matching desktop + CLI). That origin must be trusted or POSTs to
// /api/auth/device/* are rejected by Better Auth's origin/CSRF check. The
// desktop never needed this because Core calls these endpoints server-side
// (reqwest) with no Origin header.
const EXTENSION_ORIGIN =
	process.env.EXTENSION_ORIGIN ||
	"chrome-extension://eahmgoelihpjlbejliklmfcohjhpgeml";

const LOCAL_DEV_HOSTS = new Set(["localhost", "127.0.0.1"]);

function frontendOrigin(): string | undefined {
	const frontendUrl = process.env.FRONTEND_URL || "http://localhost:3001";
	try {
		return new URL(frontendUrl).origin;
	} catch {
		return undefined;
	}
}

/** Strip a leading `www.` so api.ryuhq.com + www.ryuhq.com share ryuhq.com. */
function normalizeHostname(hostname: string): string {
	return hostname.replace(/^www\./, "");
}

/**
 * When the auth API and marketing web live on sibling subdomains (api.ryuhq.com
 * vs ryuhq.com), the session cookie must use the shared parent domain or SSR on
 * the apex never sees it and /login <-> /dashboard loops forever. Explicit
 * AUTH_COOKIE_DOMAIN wins; otherwise infer from FRONTEND_URL + BETTER_AUTH_URL.
 */
function resolveAuthCookieDomain(): string | undefined {
	if (env.AUTH_COOKIE_DOMAIN) {
		return env.AUTH_COOKIE_DOMAIN;
	}

	const frontendUrl = process.env.FRONTEND_URL;
	if (!frontendUrl) {
		return undefined;
	}

	try {
		const authHost = normalizeHostname(new URL(env.BETTER_AUTH_URL).hostname);
		const frontendHost = normalizeHostname(new URL(frontendUrl).hostname);

		if (authHost === frontendHost) {
			return undefined;
		}
		if (LOCAL_DEV_HOSTS.has(authHost) || LOCAL_DEV_HOSTS.has(frontendHost)) {
			return undefined;
		}
		if (authHost.endsWith(`.${frontendHost}`)) {
			return frontendHost;
		}
		if (frontendHost.endsWith(`.${authHost}`)) {
			return authHost;
		}
	} catch {
		return undefined;
	}

	return undefined;
}

function mergeOrigins(
	origins: string[],
	extra: Array<string | undefined>
): string[] {
	const merged = [...origins];
	for (const origin of extra) {
		if (origin && !merged.includes(origin)) {
			merged.push(origin);
		}
	}
	return merged;
}

function parseCorsOrigins(): string[] {
	const corsOrigin = process.env.CORS_ORIGIN || "";
	const defaultOrigins = mergeOrigins(
		[
			"http://localhost:3001",
			"http://localhost:1420",
			"http://localhost:5173",
			"http://localhost:5175",
			"http://127.0.0.1:3001",
			"mybettertapp://",
			"exp://",
			"ryu://",
			...TAURI_DESKTOP_ORIGINS,
			EXTENSION_ORIGIN,
		],
		[frontendOrigin()]
	);

	if (!corsOrigin.trim()) {
		return defaultOrigins;
	}

	const origins = mergeOrigins(
		corsOrigin
			.split(",")
			.map((origin) => origin.trim())
			.filter(Boolean),
		[frontendOrigin()]
	);

	// Always-trusted non-web origins (mobile schemes, desktop webview, extension)
	// regardless of CORS_ORIGIN — release desktop builds must work even when ops
	// forgets to list tauri.localhost in the env var.
	const alwaysTrusted = [
		"mybettertapp://",
		"exp://",
		"ryu://",
		...TAURI_DESKTOP_ORIGINS,
		EXTENSION_ORIGIN,
	];
	for (const scheme of alwaysTrusted) {
		if (!origins.includes(scheme)) {
			origins.push(scheme);
		}
	}

	return origins;
}

/**
 * Recover a referral code from the `ryu_ref` cookie on the sign-up request.
 * Social/OAuth sign-up (`signIn.social`) has no request body to carry a
 * `referredBy` field, so a Google-referred visitor's code only survives as the
 * cookie the web client set when they landed on a `?ref=` link. The DB create
 * hook reads it here so social referrals attribute the same as email/password.
 * Defensive against Better Auth's context shape: returns undefined if the
 * cookie (or the context) is absent, so a missing cookie is simply a no-op.
 */
function referredByFromCookie(context: unknown): string | undefined {
	const ctx = context as
		| {
				headers?: { get?: (k: string) => string | null } | null;
				request?: {
					headers?: { get?: (k: string) => string | null } | null;
				} | null;
		  }
		| null
		| undefined;
	const cookieHeader =
		ctx?.headers?.get?.("cookie") ??
		ctx?.request?.headers?.get?.("cookie") ??
		null;
	if (!cookieHeader) {
		return;
	}
	for (const part of cookieHeader.split(";")) {
		const eq = part.indexOf("=");
		if (eq === -1) {
			continue;
		}
		const key = part.slice(0, eq).trim();
		if (key === "ryu_ref") {
			const value = decodeURIComponent(part.slice(eq + 1).trim()).trim();
			return value || undefined;
		}
	}
	return;
}

export const auth = betterAuth({
	database: mongodbAdapter(client),
	trustedOrigins: parseCorsOrigins(),
	appName: "Ryu",
	secret: env.BETTER_AUTH_SECRET,
	baseURL: env.BETTER_AUTH_URL,
	socialProviders: {
		google: {
			clientId: process.env.GOOGLE_CLIENT_ID as string,
			clientSecret: process.env.GOOGLE_CLIENT_SECRET as string,
		},
	},
	account: {
		accountLinking: {
			enabled: true,
			trustedProviders: ["google"],
			allowUnlinkingAll: true,
		},
	},
	emailAndPassword: {
		enabled: true,
		requireEmailVerification: true,
		sendResetPassword: async ({
			user,
			url,
		}: {
			user: EmailUser;
			url: string;
			token: string;
		}) => {
			try {
				await sendEmail({
					to: user.email,
					subject: "Let's get you a new password",
					react: PasswordResetEmail({
						userName: user.name || "there",
						resetUrl: url,
					}),
				});
			} catch (error) {
				console.error("Failed to send password reset email:", error);
				if (
					error instanceof Error &&
					errorCode(error) === "RATE_LIMIT_EXCEEDED"
				) {
					const retryAfter = retryAfterSeconds(error);
					throw new Error(
						retryAfter
							? `Please wait ${retryAfter} seconds before requesting another password reset email`
							: "Please wait before requesting another password reset email"
					);
				}
				throw error;
			}
		},
	},
	emailVerification: {
		sendOnSignUp: true,
		autoSignInAfterVerification: true,
		sendVerificationEmail: async ({
			user,
			url,
		}: {
			user: EmailUser;
			url: string;
			token: string;
		}) => {
			try {
				const parsedUrl = new URL(url);
				parsedUrl.searchParams.set(
					"callbackURL",
					`${process.env.FRONTEND_URL || "http://localhost:3001"}/email-verified`
				);

				await sendEmail({
					to: user.email,
					subject: "Let's make it official",
					react: VerificationEmail({
						userName: user.name || "there",
						verificationUrl: parsedUrl.toString(),
					}),
				});

				try {
					await subscribeContact(user.email, user.name ?? undefined);
				} catch (subscribeError) {
					console.error(
						"Failed to subscribe contact (non-critical):",
						subscribeError
					);
				}
			} catch (error) {
				console.error("Failed to send verification email:", error);
				if (
					error instanceof Error &&
					errorCode(error) === "RATE_LIMIT_EXCEEDED"
				) {
					const retryAfter = retryAfterSeconds(error);
					throw new Error(
						retryAfter
							? `Please wait ${retryAfter} seconds before requesting another verification email`
							: "Please wait before requesting another verification email"
					);
				}
				throw error;
			}
		},
	},
	user: {
		additionalFields: {
			avatarId: {
				type: "string",
				input: false,
			},
			resendContactId: {
				type: "string",
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
			// share link). The waitlist itself rides the admin-plugin `role` field.
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
		return {
			// When the frontend and auth API live on different subdomains
			// (ryuhq.com vs api.ryuhq.com), the session cookie must carry the shared
			// parent domain (AUTH_COOKIE_DOMAIN="ryuhq.com") so the apex SSR portal gate
			// can read it.
			// Without this it is host-only on the API subdomain, invisible to SSR, and
			// /dashboard <-> /login loops forever. Env-gated so local dev (no shared
			// parent) keeps host-only cookies.
			...(authCookieDomain
				? {
						crossSubDomainCookies: {
							enabled: true,
							domain: authCookieDomain,
						},
					}
				: {}),
			defaultCookieAttributes: {
				sameSite: "lax",
				secure: process.env.NODE_ENV === "production",
				httpOnly: true,
			},
		};
	})(),
	hooks: {
		before: createAuthMiddleware(async (ctx) => {
			if (ctx.path === "/sign-in/email") {
				const body = ctx.body as { email?: string };
				if (!body?.email) {
					return;
				}

				const user = await ctx.context.internalAdapter.findUserByEmail(
					body.email.toLowerCase(),
					{ includeAccounts: true }
				);

				if (
					user?.accounts &&
					!user.accounts.find(
						(account: AuthAccount) => account.providerId === "credential"
					)
				) {
					throw new APIError("UNAUTHORIZED", {
						message: "NO_PASSWORD_ACCOUNT",
					});
				}
			}
		}),
		after: createAuthMiddleware(async (ctx) => {
			if (ctx.path === "/change-password") {
				const session = ctx.context.session;
				if (session?.user) {
					try {
						await sendEmail({
							to: session.user.email,
							subject: "Your new password is live",
							react: PasswordChangeEmail({
								userName: session.user.name || "there",
							}),
						});
					} catch (error) {
						console.error(
							"Failed to send password change notification email:",
							error
						);
					}
				}
			}
		}),
	},
	databaseHooks: {
		session: {
			create: {
				before: async (session: { userId: string }) => {
					// Start every new session scoped to the user's personal org so
					// org-scoped reads (the control plane reads the `member` collection)
					// resolve immediately on first login. Earliest membership = the
					// personal org created at sign-up. Fail-open: a lookup error just
					// leaves the session without an active org rather than blocking login.
					try {
						const member = await Member.findOne({ userId: session.userId })
							.sort({ createdAt: 1 })
							.lean();
						if (member?.organizationId) {
							return {
								data: {
									...session,
									activeOrganizationId: member.organizationId,
								},
							};
						}
					} catch (error) {
						console.error(
							"Failed to resolve initial active organization:",
							error
						);
					}
				},
			},
		},
		user: {
			create: {
				// biome-ignore lint/suspicious/useAwait: Better Auth's before-hook type requires a Promise return.
				before: async (user, context) => {
					// Stamp every new user with a referral code. Normalize any inbound
					// referral code to the canonical upper-case form. (Role is set in the
					// after hook so it reliably overrides the admin plugin's default.)
					const inboundReferredBy = (user as { referredBy?: string | null })
						.referredBy;
					// Email/password sign-up threads `referredBy` in the body (wins here);
					// social/OAuth sign-up has no body, so fall back to the `ryu_ref`
					// cookie the web client set at the ?ref= landing. Without this,
					// Google-referred signups silently attribute to no one.
					const rawReferredBy =
						inboundReferredBy || referredByFromCookie(context);
					const referredBy = rawReferredBy
						? rawReferredBy.trim().toUpperCase()
						: undefined;
					return {
						data: {
							...user,
							referralCode: generateReferralCode(),
							referralCount: 0,
							...(referredBy ? { referredBy } : {}),
						},
					};
				},
				after: async (user: {
					id: string;
					email: string;
					name?: string;
					role?: string;
					referralCode?: string;
					referralCount?: number;
					referredBy?: string;
				}) => {
					await ensurePolarCustomer({
						id: user.id,
						email: user.email,
						name: user.name,
					});
					// Credit the referrer (if any) so referrals move them up the queue.
					// Best-effort: a bad/unknown code just means no credit.
					if (user.referredBy) {
						try {
							await User.updateOne(
								{ referralCode: user.referredBy },
								{ $inc: { referralCount: 1 } }
							);
						} catch (error) {
							console.error("Failed to credit referrer:", error);
						}
					}
					// Put the new user in the queue (role WAITLIST_ROLE); admins skip it
					// and keep the normal role. This overrides the admin plugin's default
					// "user" role. Written via Mongoose so it definitely persists. Also
					// ensure a referral code exists.
					const approved = isAdminEmail(user.email);
					// Support staff (the admin allowlist) get the real "admin" role so
					// the admin plugin's impersonation primitive accepts them (#545).
					// With no admins configured (self-hosted, ADMIN_EMAILS empty) nobody
					// could ever approve a queued user, so signups are auto-approved
					// (APPROVED_ROLE) instead of dead-ending on the waitlist; otherwise
					// everyone else is queued (WAITLIST_ROLE), fail-closed as before.
					const queued = !(approved || isWaitlistBypassed());
					let resolvedRole = APPROVED_ROLE;
					if (approved) {
						resolvedRole = ADMIN_ROLE;
					} else if (queued) {
						resolvedRole = WAITLIST_ROLE;
					}
					const referralCode = user.referralCode ?? generateReferralCode();
					try {
						await User.updateOne(
							{ _id: user.id },
							{ $set: { role: resolvedRole } }
						);
						await User.updateOne(
							{ _id: user.id, referralCode: { $in: [null, undefined, ""] } },
							{ $set: { referralCode, referralCount: user.referralCount ?? 0 } }
						);
					} catch (error) {
						console.error("Failed to set waitlist role:", error);
					}
					// Welcome queued users with their position and personal referral link.
					// Admins and auto-approved (waitlist-bypassed) users skip this — they
					// were never in the queue, so a position email would be wrong.
					if (queued) {
						try {
							const position = await waitlistPositionFor(user.id);
							const referralUrl = referralCode
								? referralUrlFor(referralCode)
								: `${webOrigin()}/login?view=signup`;
							await sendEmail({
								to: user.email,
								subject: "You're on the list, here's what's next",
								react: WaitlistConfirmationEmail({
									name: user.name,
									position,
									referralUrl,
								}),
								// Fires right after the verification email — bypass the cooldown
								// so it isn't silently dropped.
								skipRateLimit: true,
							});
						} catch (error) {
							console.error(
								"Failed to send waitlist confirmation email:",
								error
							);
						}
					}
					// Give every new user a personal organization so they always have a
					// valid org context. Wrapped so a failure here never fails sign-up,
					// exactly like the Polar provisioning above.
					try {
						await ensurePersonalOrganization(
							user.id,
							auth.api as unknown as OrganizationApi
						);
					} catch (error) {
						console.error(
							"Failed to create personal organization for user:",
							error
						);
					}
				},
			},
			update: {
				after: async (user: { id: string; email: string; name?: string }) => {
					await syncPolarCustomer({
						id: user.id,
						email: user.email,
						name: user.name,
					});
				},
			},
		},
	},
	plugins: [
		captcha({
			provider: "cloudflare-turnstile",
			secretKey: TURNSTILE_SECRET_KEY,
		}),
		twoFactor({
			issuer: "Ryu",
			otpOptions: {
				async sendOTP({ user, otp }) {
					try {
						await sendEmail({
							to: user.email,
							subject: "One more step to get you in",
							react: TwoFactorOTPEmail({
								userName: user.name || "there",
								otpCode: otp,
							}),
						});
					} catch (error) {
						console.error("Failed to send 2FA OTP email:", error);
						if (
							error instanceof Error &&
							errorCode(error) === "RATE_LIMIT_EXCEEDED"
						) {
							const retryAfter = retryAfterSeconds(error);
							throw new Error(
								retryAfter
									? `Please wait ${retryAfter} seconds before requesting another 2FA code`
									: "Please wait before requesting another 2FA code"
							);
						}
						throw error;
					}
				},
				period: 5,
				storeOTP: "encrypted",
			},
			backupCodesOptions: {
				amount: 10,
				length: 10,
				storeBackupCodes: "encrypted",
			},
		}),
		emailOTP({
			async sendVerificationOTP({ email, otp, type }) {
				try {
					if (type === "sign-in") {
						let userName = "there";
						try {
							const user = await User.findOne({ email: email.toLowerCase() });
							userName = user?.name || "there";
						} catch {
							// Use generic greeting if user not found
						}

						await sendEmail({
							to: email,
							subject: `Your sign-in code is ${otp}`,
							react: SignInOTPEmail({
								userName,
								otpCode: otp,
							}),
						});
					} else {
						await sendEmail({
							to: email,
							subject: "Here's your sign-in code",
							react: SignInOTPEmail({
								userName: "there",
								otpCode: otp,
							}),
						});
					}
				} catch (error) {
					console.error("Failed to send email OTP:", error);
					if (
						error instanceof Error &&
						errorCode(error) === "RATE_LIMIT_EXCEEDED"
					) {
						const retryAfter = retryAfterSeconds(error);
						throw new Error(
							retryAfter
								? `Please wait ${retryAfter} seconds before requesting another sign-in code`
								: "Please wait before requesting another sign-in code"
						);
					}
					throw error;
				}
			},
			otpLength: 6,
			expiresIn: 300,
			sendVerificationOnSignUp: false,
			storeOTP: "encrypted",
			disableSignUp: false,
		}),
		magicLink({
			sendMagicLink: async ({ email, url }, ctx) => {
				try {
					let userName = "there";
					try {
						const user = await ctx?.context?.adapter?.findOne?.<{
							name?: string;
						}>({
							model: "user",
							where: [{ field: "email", value: email.toLowerCase() }],
						});
						userName = user?.name || "there";
					} catch {
						// Use generic greeting if user not found
					}

					await sendEmail({
						to: email,
						subject: "Let's get you signed in",
						react: MagicLinkEmail({
							userName,
							magicLinkUrl: url,
						}),
					});
				} catch (error) {
					console.error("Failed to send magic link email:", error);
					if (
						error instanceof Error &&
						errorCode(error) === "RATE_LIMIT_EXCEEDED"
					) {
						const retryAfter = retryAfterSeconds(error);
						throw new Error(
							retryAfter
								? `Please wait ${retryAfter} seconds before requesting another sign-in link`
								: "Please wait before requesting another sign-in link"
						);
					}
					throw error;
				}
			},
			expiresIn: 300,
		}),
		polar({
			client: polarClient,
			// Customer provisioning is handled by databaseHooks.user.create.after via
			// ensurePolarCustomer so a Polar/API error never makes sign-up fail.
			createCustomerOnSignUp: false,
			enableCustomerPortal: true,
			use: [
				checkout({
					products: POLAR_PRODUCTS,
					successUrl: env.POLAR_SUCCESS_URL,
					authenticatedUsersOnly: true,
				}),
				portal(),
			],
		}),
		deviceAuthorization({
			verificationUri: `${process.env.FRONTEND_URL || "http://localhost:3001"}/device`,
			validateClient: (clientId) =>
				["ryu-desktop", "ryu-cli", "ryu-extension"].includes(clientId),
		}),
		// The built-in GET /device only returns { user_code, status } — it hides the
		// requesting clientId/scope. The approve consent screen needs to name the app
		// asking for access ("Ryu Desktop is requesting…"), so expose a read-only
		// lookup that surfaces the persisted clientId + scope for a pending code.
		{
			id: "device-authorization-info",
			endpoints: {
				getDeviceInfo: createAuthEndpoint(
					"/device/info",
					{ method: "GET" },
					async (ctx) => {
						const userCode = (ctx.query?.user_code ?? "")
							.replace(/-/g, "")
							.toUpperCase();
						if (!userCode) {
							throw new APIError("BAD_REQUEST", {
								error: "invalid_request",
								error_description: "user_code is required",
							});
						}
						const record = await ctx.context.adapter.findOne<{
							clientId?: string | null;
							scope?: string | null;
							status?: string | null;
						}>({
							model: "deviceCode",
							where: [{ field: "userCode", value: userCode }],
						});
						if (!record) {
							throw new APIError("NOT_FOUND", {
								error: "invalid_request",
								error_description: "Unknown or expired code",
							});
						}
						return ctx.json({
							clientId: record.clientId ?? null,
							scope: record.scope ?? null,
							status: record.status ?? null,
						});
					}
				),
			},
		},
		bearer(),
		// Multi-account: keep multiple concurrent device sessions in one browser
		// so a user can switch between accounts (Notion-style). Cookie-based, so it
		// drives web directly; the Bearer surfaces (desktop/cli/tui/extension/native)
		// each keep their own local token vault and switch the active bearer token.
		multiSession({ maximumSessions: 5 }),
		expo(),
		admin({
			// Support access (#545): cap any impersonation session at 1 hour, the AC
			// ceiling for a user-granted support session. Admins still cannot
			// impersonate other admins by default (Better Auth's built-in behavior —
			// we deliberately do NOT grant the `impersonate-admins` permission).
			impersonationSessionDuration: 60 * 60,
		}),
		lastLoginMethod(),
		username({
			minUsernameLength: 3,
			maxUsernameLength: 32,
		}),
		jwt({
			jwt: {
				// Enrich the JWT so a node's Core can verify org membership + role
				// OFFLINE (it validates the signature against the JWKS, no live call to
				// better-auth). definePayload only receives `user` (not the session), so
				// we resolve every org the user belongs to from the `member`
				// collection, the same source of truth the control plane reads from.
				// Core picks the
				// membership matching its bound org. Fail-open: a lookup error must
				// never block token issuance, so we fall back to a user-only payload.
				definePayload: async ({ user }) => {
					const base = { id: user.id, email: user.email };
					try {
						const members = await Member.find({ userId: user.id }).lean();
						const orgs = members.map((member) => ({
							id: member.organizationId,
							role: member.role,
						}));
						return { ...base, orgs };
					} catch (error) {
						console.error("Failed to embed org memberships in JWT:", error);
						return base;
					}
				},
			},
		}),
		// oidcProvider owns /oauth2/{authorize,token,register,userinfo} +
		// /.well-known/openid-configuration (the auth-code flow the desktop and
		// extension PKCE clients use). It ALSO declares POST /oauth2/consent (endpoint
		// key "oAuthConsent"), but so does the mcp plugin below, which reuses an
		// internal oidcProvider and re-exposes the very same handler. Two plugins
		// registering the same path+method makes Better Auth log an "endpoint path
		// conflicts" ERROR at boot and silently shadow one of them. We keep the mcp
		// plugin's consent handler (it carries the full RYU scope config and is what
		// third-party MCP consent flows reach) and strip the duplicate here so exactly
		// one handler owns /oauth2/consent. Ryu's first-party clients set skipConsent,
		// so they never hit this endpoint anyway; both handlers operate on the same
		// shared oauth tables, so the surviving one serves /oauth2/* consent correctly.
		(() => {
			const provider = oidcProvider({
				loginPage: `${process.env.FRONTEND_URL || "http://localhost:3001"}/login`,
				consentPage: `${process.env.FRONTEND_URL || "http://localhost:3001"}/oauth/consent`,
			});
			// biome-ignore lint/performance/noDelete: remove endpoint key so Better Auth does not register this route
			delete (provider.endpoints as Record<string, unknown>).oAuthConsent;
			return provider;
		})(),
		// Scoped programmatic access tokens (PATs). Each key carries access-control
		// statements from the shared Ryu scope vocabulary (see scopes.ts) that Core
		// (the resource server) and the Gateway enforce. We deliberately do NOT set
		// enableSessionForAPIKeys: a scoped token must never be silently as powerful
		// as a full login session. Consumers verify + gate via
		// auth.api.verifyApiKey({ body: { key, permissions } }). Keys are user-owned
		// (the default `references: "user"`); org-owned keys are a follow-up.
		apiKey({
			enableMetadata: true,
			permissions: {
				defaultPermissions: async (referenceId) => {
					try {
						const user = await User.findById(referenceId).lean();
						return defaultPermissionsForRole(user?.role);
					} catch (error) {
						console.error(
							"[auth] apiKey defaultPermissions lookup failed:",
							error
						);
						// Fail CLOSED. A scoped token defaulting its own ceiling must never
						// widen on error: if we cannot read the role, mint a key with no
						// permissions rather than the write-capable standard set (which is
						// what an absent role resolves to). The caller can always pass
						// explicit permissions, and a re-create succeeds once the DB is
						// healthy.
						return {};
					}
				},
			},
		}),
		// MCP OAuth: makes Better Auth the OAuth 2.1 provider MCP clients require.
		// It reuses the OIDC provider machinery internally (id "mcp"), serving
		// /.well-known/oauth-authorization-server + /.well-known/oauth-protected-resource
		// and the /mcp/{authorize,token,register,get-session} endpoints. The
		// standalone oidcProvider above keeps owning /oauth2/{authorize,token,register,
		// userinfo} + /.well-known/openid-configuration (the auth-code flow the desktop
		// and extension PKCE clients use).
		//
		// This plugin owns the surviving /oauth2/consent handler (endpoint key
		// "oAuthConsent"). The standalone oidcProvider above declares the same route,
		// so we strip its copy there to avoid Better Auth's boot-time "endpoint path
		// conflicts" ERROR; this mcp handler carries the full RYU scope config. Ryu's
		// first-party OAuth clients set skipConsent, so only consenting MCP/third-party
		// clients hit it, and this handler serves them correctly (both plugins operate
		// on the same shared oauth tables). Public MCP clients self-register (dynamic
		// client registration) and are required to use PKCE.
		mcp({
			loginPage: `${process.env.FRONTEND_URL || "http://localhost:3001"}/login`,
			oidcConfig: {
				loginPage: `${process.env.FRONTEND_URL || "http://localhost:3001"}/login`,
				consentPage: `${process.env.FRONTEND_URL || "http://localhost:3001"}/oauth/consent`,
				scopes: RYU_SUPPORTED_SCOPES,
				defaultScope: "openid",
				requirePKCE: true,
				// requirePKCE alone is not enough: Better Auth defaults
				// allowPlainCodeChallengeMethod to true, which accepts
				// code_challenge_method=plain (challenge == verifier). For a public,
				// self-registering MCP client that hands most of PKCE's protection back
				// to anyone who observes the authorization request. Force S256 only, per
				// OAuth 2.1 / the MCP auth spec.
				allowPlainCodeChallengeMethod: false,
				allowDynamicClientRegistration: true,
				accessTokenExpiresIn: 3600,
			},
		}),
		organization({
			// The creator of an org becomes its owner. This is the single source of
			// truth the control plane reads from (the `member` collection).
			creatorRole: "owner",
			teams: {
				enabled: true,
				maximumTeams: 50,
				allowRemovingAllTeams: true,
			},
			// Providing this implementation enables member invitations. The invite
			// link lands on the web org shell where the invitee accepts.
			sendInvitationEmail: async (data) => {
				const frontendUrl = process.env.FRONTEND_URL || "http://localhost:3001";
				const inviteUrl = `${frontendUrl}/organizations/accept-invitation/${data.id}`;
				try {
					await sendEmail({
						to: data.email,
						subject: `Come build with ${data.organization.name} on Ryu`,
						react: OrganizationInvitationEmail({
							invitedByName: data.inviter.user.name || data.inviter.user.email,
							organizationName: data.organization.name,
							inviteUrl,
						}),
					});
				} catch (error) {
					console.error("Failed to send organization invitation email:", error);
				}
			},
		}),
	],
});
