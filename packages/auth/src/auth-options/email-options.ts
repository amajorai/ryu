import { User } from "@ryu/db/models/auth.model";
import {
	AccountExistsEmail,
	PasswordResetEmail,
	sendEmail,
	VerificationEmail,
} from "@ryu/email";
import type { BetterAuthOptions } from "better-auth";
import { creditPendingReferral } from "../lib/referral-credit.ts";
import {
	revokeUnprovenSocialSignupAccessInAuthContext,
	type UnprovenAccessUser,
} from "../lib/unproven-social-signup-access.ts";
import { authApi } from "./auth-instance.ts";
import { retryAfterSeconds } from "./email-rate-limit.ts";
import type { EmailUser } from "./login-activity.ts";
import { errorCode } from "./schemas.ts";
import { reconcileAdminRole } from "./team-claims.ts";

// Email-and-password sign-up and the email verification flow.

export const emailAuthOptions = {
	emailAndPassword: {
		enabled: true,
		minPasswordLength: 8,
		maxPasswordLength: 128,
		requireEmailVerification: true,
		// `requireEmailVerification` makes Better Auth answer a sign-up for an
		// already-registered address with a *generic success* — a synthetic user,
		// no error, and (without this hook) no email at all. That protects against
		// email enumeration, but it strands the person: the UI says "check your
		// email" and nothing ever lands. This hook makes that promise true.
		//
		// Runs inside the sign-up handler, so after captcha and after the request
		// body has been validated, and Better Auth dispatches it in the background
		// so it adds no timing signal. `sendEmail` is per-recipient rate limited
		// (60s cooldown + daily cap, see `checkEmailRateLimit`), so repeat attempts
		// against a known address cannot be turned into a mail bomb.
		//
		// NOTE: `onExistingUserSignUp` is implemented in better-auth 1.5.2
		// (`api/routes/sign-up.mjs`) but absent from its published `.d.mts`, so
		// nothing type-checks the name — a rename on upgrade goes silently inert.
		// Re-grep the option name in `better-auth/dist` when bumping.
		onExistingUserSignUp: async ({
			user,
		}: {
			user: EmailUser & { emailVerified?: boolean };
		}) => {
			try {
				if (user.emailVerified) {
					const frontendUrl =
						process.env.FRONTEND_URL || "http://localhost:3001";
					await sendEmail({
						to: user.email,
						subject: "You already have a Ryu account",
						react: AccountExistsEmail({
							userName: user.name || undefined,
							signInUrl: `${frontendUrl}/login?view=signin`,
							resetPasswordUrl: `${frontendUrl}/login?view=forgot`,
						}),
					});
					return;
				}
				// Account exists but was never verified: re-send the verification
				// email so this sign-up attempt actually completes the signup.
				await authApi().sendVerificationEmail({
					body: { email: user.email, callbackURL: "/" },
				});
			} catch (error) {
				// Never propagate. A throw here would turn the generic 200 into a
				// 5xx and hand back the exact enumeration oracle this branch exists
				// to close — including on a benign rate-limit hit.
				console.error("Failed to send existing-account sign-up email:", error);
			}
		},
		// A password reset proves the mailbox. An unverified account a social
		// identity created must not keep that identity's link or sessions once
		// the mailbox owner adopts it (lib/unproven-social-signup-access.ts).
		// The new password is the owner's, so the credential stays.
		onPasswordReset: async ({ user }: { user: UnprovenAccessUser }) => {
			await revokeUnprovenSocialSignupAccessInAuthContext(user, {
				keepCredential: true,
			});
		},
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
						userName: user.name || undefined,
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
						userName: user.name || undefined,
						verificationUrl: parsedUrl.toString(),
					}),
				});
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
		// The verification link and the email-OTP verification flip
		// emailVerified without Better Auth's unproven-link cleanup, so strip
		// what an unverified social sign-up holds first. A failure throws and
		// leaves the account unverified rather than adopted with that access.
		beforeEmailVerification: async (user: UnprovenAccessUser) => {
			await revokeUnprovenSocialSignupAccessInAuthContext(user, {
				keepCredential: false,
			});
		},
		// Better Auth owns the emailVerified boolean. Keep the timestamp in
		// Ryu's read-compatible Mongoose mirror so public profiles can show
		// when the email signal was established without exposing the address.
		afterEmailVerification: async (user: { id: string }) => {
			try {
				await User.updateOne(
					{ _id: user.id },
					{
						$set: { emailVerifiedAt: new Date() },
					}
				);
			} catch (error) {
				// A display timestamp must never turn a successful mailbox verification
				// into a failed sign-in. The boolean remains Better Auth's authority.
				console.error("Failed to record email verification timestamp:", error);
			}
			// A referee who signed up unverified earns their referrer's credit now.
			// Idempotent and self-contained, so it cannot fail the verification.
			await creditPendingReferral(user.id);
			// An allowlisted address held back at sign-up for want of proof gets
			// its admin role now. Fail-open, like the referral credit above.
			await reconcileAdminRole(user.id);
		},
	},
} satisfies Partial<BetterAuthOptions>;
