/**
 * Revoke the access a social identity holds on an account it created without
 * proving the mailbox.
 *
 * Before social sign-up required a provider-verified email
 * (lib/social-link-email-verified.ts), a Google, GitHub or Discord identity
 * whose provider had NOT verified an address could create the Ryu account for
 * it. That identity stays linked. Better Auth strips unproven links when an
 * email-OTP sign-in or a magic link first verifies such an account
 * (`revokeUnprovenAccountAccess`), but the verification link, the email-OTP
 * verification and password resets verify or adopt the account without it, so
 * the identity would keep signing in to the account the mailbox owner now uses.
 *
 * Those paths call this first. It acts only on an account that is still
 * unverified and was created through a social provider: one of its social
 * links was created together with the user. Since social sign-up requires a
 * provider-verified email, a newly created account never matches, and an
 * account created by email, SSO or an admin and linked later never matches.
 * For a match it deletes the account's links (keeping the credential the
 * mailbox owner just set in a password reset) and every session, the same
 * cleanup Better Auth applies on its own email-first proofs.
 */
import { getCurrentAuthContext } from "@better-auth/core/context";
import { ACCOUNT_LINKING_SOCIAL_PROVIDER_IDS } from "./social-provider-policy.ts";

/** A social link created this close to its user created that user. */
export const SOCIAL_SIGNUP_ACCOUNT_WINDOW_MS = 10_000;

export interface UnprovenAccessUser {
	createdAt?: Date | string | null;
	emailVerified?: boolean | null;
	id: string;
}

export interface UnprovenAccessAccount {
	createdAt?: Date | string | null;
	id: string;
	providerId: string;
}

export interface UnprovenAccessStore {
	deleteAccount: (accountId: string) => Promise<unknown>;
	deleteUserSessions: (userId: string) => Promise<unknown>;
	findAccounts: (userId: string) => Promise<UnprovenAccessAccount[]>;
}

export interface RevokeUnprovenSocialSignupOptions {
	/** Keep the credential account a password reset has just written. */
	keepCredential: boolean;
}

const SOCIAL_PROVIDER_IDS: ReadonlySet<string> = new Set(
	ACCOUNT_LINKING_SOCIAL_PROVIDER_IDS
);

function timeOf(value: Date | string | null | undefined): number | null {
	if (value === null || value === undefined) {
		return null;
	}
	const time = new Date(value).getTime();
	return Number.isNaN(time) ? null : time;
}

/** Whether one of the user's social links created the user. */
export function wasCreatedBySocialSignup(
	user: UnprovenAccessUser,
	accounts: readonly UnprovenAccessAccount[]
): boolean {
	const userCreatedAt = timeOf(user.createdAt);
	if (userCreatedAt === null) {
		return false;
	}
	return accounts.some((account) => {
		const accountCreatedAt = timeOf(account.createdAt);
		return (
			SOCIAL_PROVIDER_IDS.has(account.providerId) &&
			accountCreatedAt !== null &&
			Math.abs(accountCreatedAt - userCreatedAt) <=
				SOCIAL_SIGNUP_ACCOUNT_WINDOW_MS
		);
	});
}

/**
 * Deletes the links and sessions of a still-unverified account created through
 * a social provider. Returns whether anything was revoked.
 */
export async function revokeUnprovenSocialSignupAccess(
	user: UnprovenAccessUser,
	store: UnprovenAccessStore,
	options: RevokeUnprovenSocialSignupOptions
): Promise<boolean> {
	if (user.emailVerified === true) {
		return false;
	}
	const accounts = await store.findAccounts(user.id);
	if (!wasCreatedBySocialSignup(user, accounts)) {
		return false;
	}
	for (const account of accounts) {
		if (options.keepCredential && account.providerId === "credential") {
			continue;
		}
		await store.deleteAccount(account.id);
	}
	await store.deleteUserSessions(user.id);
	return true;
}

/** The same revocation, through the running Better Auth endpoint's adapter. */
export async function revokeUnprovenSocialSignupAccessInAuthContext(
	user: UnprovenAccessUser,
	options: RevokeUnprovenSocialSignupOptions
): Promise<boolean> {
	const { context } = await getCurrentAuthContext();
	return await revokeUnprovenSocialSignupAccess(
		user,
		context.internalAdapter,
		options
	);
}
