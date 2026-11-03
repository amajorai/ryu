import { polar } from "@polar-sh/better-auth";
import { User } from "@ryu/db/models/auth.model";
import {
	EmailVerificationOTPEmail,
	MagicLinkEmail,
	PasswordResetOTPEmail,
	SignInOTPEmail,
	sendEmail,
	TwoFactorOTPEmail,
} from "@ryu/email";
import { env } from "@ryu/env/server";
import type { BetterAuthOptions } from "better-auth";
import {
	anonymous,
	captcha,
	emailOTP,
	magicLink,
	oneTap,
	oneTimeToken,
	twoFactor,
} from "better-auth/plugins";
import { adminAbuseGuardPlugin } from "../lib/admin-abuse-guard-plugin.ts";
import { ageEligibilityPlugin } from "../lib/age-eligibility-plugin.ts";
import { createRyuAuthI18nPlugin } from "../lib/auth-i18n.ts";
import { bannedSignInPlugin } from "../lib/banned-sign-in-plugin.ts";
import { ryuEmailHarmony } from "../lib/email-harmony.ts";
import { polarClient } from "../lib/payments.ts";
import { retryAfterSeconds } from "./email-rate-limit.ts";
import { createRyuPasskeyPlugin } from "./identity-plugins.ts";
import {
	TURNSTILE_CAPTCHA_ENABLED,
	TURNSTILE_SECRET_KEY,
} from "./login-activity.ts";
import { errorCode } from "./schemas.ts";

// Plugins that guard and provide sign-in: abuse guard, age gate, captcha,
// guest, one-tap, passkey, two-factor, email OTP, magic link and billing.

const optionalPolarPlugins: Parameters<typeof polar>[0]["use"][number][] = [];

export const signInPlugins = [
	// FIRST on purpose. The admin plugin's account-control endpoints (ban,
	// unban, set-role, remove, set-password, revoke sessions, create/update
	// user) answer 404 unless the root-admin abuse console calls them through
	// `auth.api.*` inside its server-only context. Running before every other
	// plugin hook (age gate, support access, step-up) means a raw HTTP caller
	// learns nothing, not even that step-up would be needed.
	adminAbuseGuardPlugin(),
	// Before `admin()`: its session hook refuses a banned user with a bare
	// error, and this one runs first to add the reason label and appeal path.
	bannedSignInPlugin(),
	ageEligibilityPlugin(),
	// Better Auth owns authentication responses, so localize its standard error
	// codes at the server boundary. The product language-pack runtime owns UI
	// copy; this plugin is deliberately limited to auth errors and keeps the
	// original message in the response for support and diagnostics.
	createRyuAuthI18nPlugin(),
	// Turnstile is optional for local/self-hosted development. Better Auth treats
	// an empty secret as an internal error, which would make every local signup
	// with a widget response fail as HTTP 500. Keep the plugin in production so a
	// missing production secret remains fail-closed rather than silently disabling
	// bot protection.
	...(TURNSTILE_CAPTCHA_ENABLED
		? [
				captcha({
					// Keep the password-recovery request protected after moving from the
					// core reset-link endpoint to Email OTP. Better Auth's default list does
					// not include the Email OTP endpoint.
					endpoints: [
						"/sign-up/email",
						"/sign-in/email",
						"/request-password-reset",
						"/email-otp/request-password-reset",
					],
					provider: "cloudflare-turnstile",
					secretKey: TURNSTILE_SECRET_KEY ?? "",
				}),
			]
		: []),
	// Keep the plugin registered so legacy anonymous sessions can be removed by
	// the clients. New anonymous sign-ins are rejected by the auth hook below
	// while the hosted browser waitlist is active.
	anonymous({
		generateName: () => "Guest",
	}),
	// Google One Tap is a browser sign-in convenience. It still goes through
	// Better Auth's normal Google account-linking and user hooks, so waitlist,
	// organization provisioning, and session scoping remain authoritative.
	oneTap({
		clientId: env.GOOGLE_CLIENT_ID,
	}),
	// OTTs are reserved for an explicitly initiated app handoff (for example,
	// web -> extension/mobile). They are short-lived, hashed in MongoDB, and
	// never set a browser cookie when redeemed by a non-browser client.
	oneTimeToken({
		disableSetSessionCookie: true,
		expiresIn: 3,
		storeToken: "hashed",
	}),
	createRyuPasskeyPlugin(),
	twoFactor({
		issuer: "Ryu",
		otpOptions: {
			async sendOTP({ user, otp }) {
				try {
					await sendEmail({
						to: user.email,
						subject: "One more step to get you in",
						react: TwoFactorOTPEmail({
							userName: user.name || undefined,
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
	ryuEmailHarmony,
	emailOTP({
		async sendVerificationOTP({ email, otp, type }) {
			try {
				let userName: string | undefined;
				try {
					const user = await User.findOne({ email: email.toLowerCase() })
						.select("name")
						.lean<{ name?: string }>();
					userName = user?.name || undefined;
				} catch {
					// Use a generic greeting if the account lookup is unavailable.
				}

				const react =
					type === "sign-in"
						? SignInOTPEmail({ userName, otpCode: otp })
						: type === "email-verification"
							? EmailVerificationOTPEmail({ userName, otpCode: otp })
							: PasswordResetOTPEmail({ userName, otpCode: otp });
				const subject =
					type === "sign-in"
						? `Your sign-in code is ${otp}`
						: type === "email-verification"
							? "Your email verification code"
							: "Your password reset code";

				await sendEmail({ to: email, subject, react });
			} catch (error) {
				console.error("Failed to send email OTP:", error);
				if (
					error instanceof Error &&
					errorCode(error) === "RATE_LIMIT_EXCEEDED"
				) {
					const retryAfter = retryAfterSeconds(error);
					throw new Error(
						retryAfter
							? `Please wait ${retryAfter} seconds before requesting another email code`
							: "Please wait before requesting another email code"
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
				let userName: string | undefined;
				try {
					const user = await ctx?.context?.adapter?.findOne?.<{
						name?: string;
					}>({
						model: "user",
						where: [{ field: "email", value: email.toLowerCase() }],
					});
					userName = user?.name || undefined;
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
		// The emailed link carries the token; only its digest is stored.
		storeToken: "hashed",
	}),
	polar({
		client: polarClient,
		// Keep the Polar integration for customer/subscription webhooks, but do
		// not register its generic checkout/portal routes. All money creation is
		// owned by the org-aware billing routers below.
		// SAFETY: Polar reduces this list with an initial empty endpoint object,
		// so an empty list is supported at runtime despite its non-empty tuple
		// declaration. Billing routers own checkout/portal registration in Ryu.
		use: optionalPolarPlugins as Parameters<typeof polar>[0]["use"],
		// Customer provisioning is deferred to the billing checkout routes. This
		// prevents a personal customer created at sign-up from colliding with the
		// dedicated team customer an organization may need later.
		createCustomerOnSignUp: false,
	}),
] satisfies NonNullable<BetterAuthOptions["plugins"]>;
