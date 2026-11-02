/**
 * Bind every address SCIM writes to the organization's DNS-verified domains.
 *
 * A managed SCIM token belongs to one organization (the connection's
 * `provisioningDomainId`). Better Auth's SCIM plugin creates an account for
 * any primary email the directory sends and, for an account it manages,
 * rewrites the email on every PUT/PATCH. Without a domain rule a directory
 * could pre-create an account for an unrelated address that has no Ryu
 * account yet (`someone@gmail.com`), wait for the real owner to adopt it
 * through an email code or magic link, then rename it to an address the
 * directory controls and sign in as that user id.
 *
 * This applies the rule `sso-email-domain.ts` applies to SSO identities: a
 * SCIM create, or a SCIM rename to a new address, must land on a domain (or a
 * subdomain of one) that an SSO provider of the connection's organization has
 * DNS-verified. An organization only ever provisions addresses it proves it
 * owns. Fail closed: no SCIM connection on the request, no verified provider,
 * or an off-domain address refuses the write. A SCIM update that keeps the
 * stored address passes, so the directory can still deactivate and delete the
 * accounts it holds.
 */

import type { GenericEndpointContext } from "@better-auth/core";
import { getCurrentAdapter } from "@better-auth/core/context";
import { APIError } from "better-auth/api";
import { z } from "zod";
import { emailOnProviderDomain } from "./sso-email-domain.ts";

export const SCIM_EMAIL_DOMAIN_REFUSED = "SCIM_EMAIL_DOMAIN_REFUSED";
export const SCIM_EMAIL_DOMAIN_DETAIL =
	"Directory sync can only provision addresses on the organization's verified domains.";

export interface ScimDomainProviderRecord {
	domain?: string | null;
	domainVerified?: boolean | null;
}

const scimConnectionSchema = z
	.object({ provisioningDomainId: z.string().min(1) })
	.nullable()
	.catch(null);

const providerRecordSchema = z.object({
	domain: z.string().nullish().catch(null),
	domainVerified: z.boolean().nullish().catch(null),
});
const providerListSchema = z
	.array(z.unknown())
	.catch(() => [])
	.transform((rows) =>
		rows.flatMap((row) => {
			const parsed = providerRecordSchema.safeParse(row);
			return parsed.success ? [parsed.data] : [];
		})
	);

/** True when `email` is on a DNS-verified domain of one of `providers`. */
export function emailOnVerifiedOrganizationDomain(
	email: unknown,
	providers: readonly ScimDomainProviderRecord[]
): boolean {
	if (typeof email !== "string") {
		return false;
	}
	return providers.some(
		(provider) =>
			provider.domainVerified === true &&
			emailOnProviderDomain(email, provider.domain)
	);
}

/** The organization the request's authenticated SCIM connection belongs to. */
export function scimConnectionOrganizationId(
	ctx: { context?: unknown } | null | undefined
): string | null {
	const context = ctx?.context;
	if (!(context && typeof context === "object")) {
		return null;
	}
	const connection = (context as { scimConnection?: unknown }).scimConnection;
	return (
		scimConnectionSchema.parse(connection ?? null)?.provisioningDomainId ?? null
	);
}

function refusal(): APIError {
	return new APIError("FORBIDDEN", {
		code: SCIM_EMAIL_DOMAIN_REFUSED,
		message: SCIM_EMAIL_DOMAIN_DETAIL,
	});
}

/**
 * Refuse a SCIM write that would put `email` on an account unless the address
 * is on a verified SSO domain of the SCIM connection's organization.
 */
export async function assertScimEmailOnVerifiedDomain(
	email: unknown,
	ctx: GenericEndpointContext | null | undefined
): Promise<void> {
	const organizationId = scimConnectionOrganizationId(ctx);
	if (!(ctx && organizationId)) {
		throw refusal();
	}
	const adapter = await getCurrentAdapter(ctx.context.adapter);
	const providers = providerListSchema.parse(
		await adapter.findMany({
			model: "ssoProvider",
			where: [{ field: "organizationId", value: organizationId }],
		})
	);
	if (!emailOnVerifiedOrganizationDomain(email, providers)) {
		throw refusal();
	}
}
