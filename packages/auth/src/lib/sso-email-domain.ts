/**
 * Bind every SSO identity to its provider's DNS-verified domain.
 *
 * Better Auth's SSO plugin (1.7.1) refuses a callback from a provider whose
 * domain is unverified, but it does not refuse an asserted email outside that
 * domain: it creates the account (with `emailVerified: false`) and signs it in.
 * An organization that verified `acme.com` could therefore pre-register any
 * address that has no Ryu account yet, keep the SSO link attached, and sign
 * back in after the real owner proves the mailbox, inheriting whatever the
 * address earns (for an `ADMIN_EMAILS` address, the platform-admin role).
 *
 * This gate runs from Better Auth's `user.validateUserInfo`, which Better Auth
 * calls before it creates a user, links a provider account, and signs an
 * existing provider user in. For an SSO source it requires:
 *   - the provider exists and its domain is DNS-verified;
 *   - the asserted email is on that domain (or a subdomain of it), the same
 *     rule Better Auth uses to decide `isTrustedProvider`;
 *   - on link and sign-in, the STORED account email is on that domain too, so
 *     an account whose address moved out of the domain (an email change, a
 *     directory rename) cannot be reached through the provider any more.
 *
 * Fail closed: a missing provider id, provider row, domain or stored email
 * rejects. Non-SSO sources are not this gate's business and pass through.
 */

import type { GenericEndpointContext } from "@better-auth/core";
import { getCurrentAdapter } from "@better-auth/core/context";
import { z } from "zod";

const SSO_METHODS = new Set(["sso-oidc", "sso-saml"]);

/** Rejection codes surfaced to the SSO error redirect. */
export const SSO_DOMAIN_UNVERIFIED = "sso_domain_unverified";
export const SSO_EMAIL_DOMAIN_MISMATCH = "sso_email_domain_mismatch";

export interface SsoIdentityProviderRecord {
	domain?: string | null;
	domainVerified?: boolean | null;
}

export interface SsoIdentityStore {
	findProvider(providerId: string): Promise<SsoIdentityProviderRecord | null>;
	findUserEmail(userId: string): Promise<string | null>;
}

export interface SsoIdentityValidationInput {
	source: {
		action: string;
		method: string;
		sso?: { providerId?: string | null } | null;
	};
	user: { email?: unknown; id?: unknown };
}

export interface SsoIdentityRejection {
	error: string;
	errorDescription: string;
}

function providerDomainList(domain: string | null | undefined): string[] {
	const domains: string[] = [];
	for (const rawEntry of (domain ?? "").split(",")) {
		let entry = rawEntry.trim().toLowerCase().replace(/^@/, "");
		if (entry.includes("://")) {
			try {
				entry = new URL(entry).hostname;
			} catch {
				continue;
			}
		}
		entry = entry.replace(/\.$/, "");
		if (entry) {
			domains.push(entry);
		}
	}
	return domains;
}

/** True when `email`'s domain is one of `domain`'s entries or a subdomain of one. */
export function emailOnProviderDomain(
	email: string | null | undefined,
	domain: string | null | undefined
): boolean {
	// Same split as Better Auth's `validateEmailDomain` (the text after the
	// FIRST "@"), so an address with a second "@" cannot pass here while Better
	// Auth treats it as off-domain.
	const emailDomain = ((email ?? "").split("@")[1] ?? "").trim().toLowerCase();
	if (!emailDomain) {
		return false;
	}
	return providerDomainList(domain).some(
		(entry) => emailDomain === entry || emailDomain.endsWith(`.${entry}`)
	);
}

const MISMATCH: SsoIdentityRejection = {
	error: SSO_EMAIL_DOMAIN_MISMATCH,
	errorDescription:
		"This sign-in provider can only be used for addresses on its verified domain.",
};

/**
 * Return a rejection for an SSO identity outside its provider's verified
 * domain, or `undefined` to allow (including every non-SSO source).
 */
export async function validateSsoIdentityDomain(
	input: SsoIdentityValidationInput,
	store: SsoIdentityStore
): Promise<SsoIdentityRejection | undefined> {
	if (!SSO_METHODS.has(input.source.method)) {
		return;
	}
	const providerId = input.source.sso?.providerId;
	const provider = providerId ? await store.findProvider(providerId) : null;
	if (!(provider?.domain && provider.domainVerified === true)) {
		return {
			error: SSO_DOMAIN_UNVERIFIED,
			errorDescription: "This sign-in provider's domain is not verified.",
		};
	}
	const assertedEmail =
		typeof input.user.email === "string" ? input.user.email : null;
	if (!emailOnProviderDomain(assertedEmail, provider.domain)) {
		return MISMATCH;
	}
	if (input.source.action === "create-user") {
		return;
	}
	// Link and sign-in reach an EXISTING account; its stored address must be
	// on the domain too, whatever the provider asserts today.
	const userId = typeof input.user.id === "string" ? input.user.id : null;
	const storedEmail = userId ? await store.findUserEmail(userId) : null;
	if (!emailOnProviderDomain(storedEmail, provider.domain)) {
		return MISMATCH;
	}
	return;
}

/** The SSO provider fields the gate reads; a malformed row fails closed. */
const providerRecordSchema = z
	.object({
		domain: z.string().nullish().catch(null),
		domainVerified: z.boolean().nullish().catch(null),
	})
	.nullable()
	.catch(null);
const userRecordSchema = z
	.object({ email: z.string().nullish().catch(null) })
	.nullable()
	.catch(null);

/**
 * Better Auth `user.validateUserInfo` that applies `validateSsoIdentityDomain`
 * through the request's adapter (the open transaction's, when there is one).
 */
export async function validateSsoIdentityUserInfo(
	data: SsoIdentityValidationInput,
	ctx: GenericEndpointContext
): Promise<SsoIdentityRejection | undefined> {
	const adapter = await getCurrentAdapter(ctx.context.adapter);
	return await validateSsoIdentityDomain(data, {
		findProvider: async (providerId) =>
			providerRecordSchema.parse(
				await adapter.findOne({
					model: "ssoProvider",
					where: [{ field: "providerId", value: providerId }],
				})
			),
		findUserEmail: async (userId) =>
			userRecordSchema.parse(
				await adapter.findOne({
					model: "user",
					where: [{ field: "id", value: userId }],
				})
			)?.email ?? null,
	});
}
