/**
 * Implicit social account linking requires a provider-verified email.
 *
 * The public social providers are Better Auth `trustedProviders`, so a signed-in
 * user can link GitHub or Discord from Settings even when the provider has not
 * verified that identity's address. The same flag also lets Better Auth
 * implicitly link a provider identity onto an existing Ryu account purely
 * because the email claims match, and it then skips the provider's
 * `email_verified` claim. A provider identity that asserts an address it never
 * verified would then sign in as that address's Ryu account.
 *
 * This gate runs from `user.validateUserInfo`, which Better Auth calls before it
 * links a provider account. It refuses a social (`oauth`) link whose
 * provider-reported email is unverified unless the request is the signed-in
 * user's own explicit link flow: `linkSocial` stores `link.userId` in the
 * server-generated OAuth state, and the account is being linked to that user.
 */
import type { GenericEndpointContext } from "@better-auth/core";
import { getOAuthState } from "better-auth/api";
import {
	type SsoIdentityRejection,
	type SsoIdentityValidationInput,
	validateSsoIdentityUserInfo,
} from "./sso-email-domain.ts";

/** Rejection code surfaced to the OAuth error redirect. */
export const SOCIAL_LINK_EMAIL_UNVERIFIED = "social_link_email_unverified";

export interface SocialLinkValidationInput {
	source: { action: string; method: string };
	user: { emailVerified?: unknown; id?: unknown };
}

/** Reads the user id of the signed-in user's explicit link flow, if any. */
export type ExplicitLinkUserIdReader = () => Promise<string | null>;

/**
 * The `link.userId` Better Auth stored in this request's OAuth state. It is
 * written only by `linkSocial` (session-bound) and cannot come from the
 * client's `additionalData`. Outside an OAuth flow there is no request state.
 */
export async function readExplicitLinkUserId(): Promise<string | null> {
	try {
		const state = await getOAuthState();
		const userId = state?.link?.userId;
		return typeof userId === "string" && userId ? userId : null;
	} catch {
		return null;
	}
}

/**
 * Refuses an implicit social link of a provider identity whose email the
 * provider did not verify. Other actions and methods pass through.
 */
export async function validateSocialLinkEmailVerified(
	data: SocialLinkValidationInput,
	readLinkUserId: ExplicitLinkUserIdReader = readExplicitLinkUserId
): Promise<SsoIdentityRejection | undefined> {
	if (data.source.method !== "oauth" || data.source.action !== "link-account") {
		return;
	}
	if (data.user.emailVerified === true) {
		return;
	}
	const explicitLinkUserId = await readLinkUserId();
	if (explicitLinkUserId !== null && explicitLinkUserId === data.user.id) {
		return;
	}
	return {
		error: SOCIAL_LINK_EMAIL_UNVERIFIED,
		errorDescription:
			"The provider has not verified this email address, so it cannot be linked to an existing account. Sign in and link it from Settings.",
	};
}

/**
 * Production `user.validateUserInfo`: the social-link email gate, then the SSO
 * identity domain gate (lib/sso-email-domain.ts).
 */
export async function validateProviderUserInfo(
	data: SocialLinkValidationInput & SsoIdentityValidationInput,
	ctx: GenericEndpointContext
): Promise<SsoIdentityRejection | undefined> {
	const rejection = await validateSocialLinkEmailVerified(data);
	if (rejection) {
		return rejection;
	}
	return await validateSsoIdentityUserInfo(data, ctx);
}
