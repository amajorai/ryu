import { User } from "@ryu/db/models/auth.model";
import {
	EmailVerificationOTPEmail,
	MagicLinkEmail,
	PasswordResetOTPEmail,
	SignInOTPEmail,
	sendEmail,
	TwoFactorOTPEmail,
} from "@ryu/email";
import { runDetached } from "./detached-delivery.ts";
import { prepaidSendFor } from "./email-send-budget.ts";

/** The part of Better Auth's endpoint context a sender reads. */
interface SenderContext {
	request?: Request;
}

// The sign-in senders Better Auth calls: the 2FA code, the email code and the
// magic link. Each returns at once and does everything account-dependent
// (the greeting's name lookup, rendering, delivery) detached
// (lib/detached-delivery.ts), so the request answers after the same work
// whether or not the address belongs to an account.

async function greetingName(email: string): Promise<string | undefined> {
	try {
		const user = await User.findOne({ email: email.toLowerCase() })
			.select("name")
			.lean<{ name?: string }>();
		return user?.name || undefined;
	} catch {
		// A generic greeting when the account lookup is unavailable.
		return undefined;
	}
}

/** `twoFactor.otpOptions.sendOTP`. */
export function sendTwoFactorCode(
	{
		user,
		otp,
	}: {
		otp: string;
		user: { email: string; name?: string | null };
	},
	ctx?: SenderContext
): Promise<void> {
	const prepaid = prepaidSendFor(ctx?.request);
	runDetached(
		"two-factor code email",
		() =>
			sendEmail({
				to: user.email,
				subject: "One more step to get you in",
				react: TwoFactorOTPEmail({
					userName: user.name || undefined,
					otpCode: otp,
				}),
			}),
		prepaid
	);
	return Promise.resolve();
}

/** `emailOTP.sendVerificationOTP`. */
export function sendEmailCode(
	{
		email,
		otp,
		type,
	}: {
		email: string;
		otp: string;
		type: string;
	},
	ctx?: SenderContext
): Promise<void> {
	const prepaid = prepaidSendFor(ctx?.request);
	runDetached(
		"email code",
		async () => {
			const userName = await greetingName(email);
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
		},
		prepaid
	);
	return Promise.resolve();
}

/** `magicLink.sendMagicLink`. */
export function sendMagicLinkEmail(
	{
		email,
		url,
	}: {
		email: string;
		url: string;
	},
	ctx?: SenderContext
): Promise<void> {
	const prepaid = prepaidSendFor(ctx?.request);
	runDetached(
		"magic link email",
		async () => {
			await sendEmail({
				to: email,
				subject: "Let's get you signed in",
				react: MagicLinkEmail({
					userName: await greetingName(email),
					magicLinkUrl: url,
				}),
			});
		},
		prepaid
	);
	return Promise.resolve();
}
