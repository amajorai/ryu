import { PasswordResetEmail, sendEmail, VerificationEmail } from "@ryu/email";
import { runDetached } from "./detached-delivery.ts";
import { prepaidSendFor } from "./email-send-budget.ts";

// The password-reset and verification senders Better Auth calls. Each returns
// at once and delivers detached (lib/detached-delivery.ts): Better Auth awaits
// these callbacks inside the request, so an awaited send would make a
// registered address answer later than an unknown one.

interface EmailRecipient {
	email: string;
	name?: string | null;
}

/** `emailAndPassword.sendResetPassword`: the reset link. */
export function sendPasswordResetLink(
	{
		user,
		url,
	}: {
		user: EmailRecipient;
		url: string;
	},
	request?: Request
): Promise<void> {
	runDetached(
		"password reset email",
		() =>
			sendEmail({
				to: user.email,
				subject: "Let's get you a new password",
				react: PasswordResetEmail({
					userName: user.name || undefined,
					resetUrl: url,
				}),
			}),
		prepaidSendFor(request)
	);
	return Promise.resolve();
}

/** `emailVerification.sendVerificationEmail`: the verification link. */
export function sendVerificationLink(
	{
		user,
		url,
	}: {
		user: EmailRecipient;
		url: string;
	},
	request?: Request
): Promise<void> {
	const verificationUrl = new URL(url);
	verificationUrl.searchParams.set(
		"callbackURL",
		`${process.env.FRONTEND_URL || "http://localhost:3001"}/email-verified`
	);
	runDetached(
		"verification email",
		() =>
			sendEmail({
				to: user.email,
				subject: "Let's make it official",
				react: VerificationEmail({
					userName: user.name || undefined,
					verificationUrl: verificationUrl.toString(),
				}),
			}),
		prepaidSendFor(request)
	);
	return Promise.resolve();
}
