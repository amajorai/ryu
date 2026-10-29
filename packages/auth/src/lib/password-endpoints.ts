import { passwordSchema } from "./password-policy.ts";

/**
 * Better Auth endpoints that store a password a person chose, each with the
 * body field that carries it. Sign-up, the two ways to reset a forgotten
 * password (the mailed link and the emailed code, which is what the web reset
 * page uses) and an account's own change of password are the same decision, so
 * they are held to the same rules.
 *
 * Better Auth's own check for these is only its minimum and maximum length, so
 * every other rule has to be applied before it runs. Signing in is not listed:
 * an existing password is never judged again.
 */
const PASSWORD_FIELD_BY_PATH: ReadonlyMap<string, string> = new Map([
	["/sign-up/email", "password"],
	["/reset-password", "newPassword"],
	["/email-otp/reset-password", "password"],
	["/change-password", "newPassword"],
]);

/**
 * The message to refuse a request with when `path` stores a password and the one
 * in `body` breaks the sign-up rules; null when the request is acceptable or the
 * endpoint stores no password.
 */
export function passwordPolicyRefusal(
	path: string,
	body: unknown
): string | null {
	const field = PASSWORD_FIELD_BY_PATH.get(path);
	if (!field) {
		return null;
	}
	const password =
		typeof body === "object" && body !== null
			? Reflect.get(body, field)
			: undefined;
	const result = passwordSchema.safeParse(password);
	return result.success
		? null
		: (result.error.issues[0]?.message ?? "Choose a stronger password");
}
