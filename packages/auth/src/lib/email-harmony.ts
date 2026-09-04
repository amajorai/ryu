import { emailHarmony } from "better-auth-harmony";

/**
 * Normalize provider aliases for email sign-in and recovery while keeping the
 * address returned to users as the address they registered. The server-side
 * plugin also rejects disposable mailboxes on the email-auth endpoints it
 * owns. `normalizedEmail` is an internal lookup key, not a client field.
 */
export const ryuEmailHarmony = emailHarmony({
	allowNormalizedSignin: true,
});
