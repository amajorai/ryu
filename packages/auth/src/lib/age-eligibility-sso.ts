import { z } from "zod";
import { providerIdFromSsoCallbackPath } from "./sso-organization.ts";

/** The slice of a Better Auth endpoint context the SSO exemption reads. */
export interface SsoProvisioningContext {
	context: {
		adapter: {
			findOne: (query: {
				model: string;
				where: { field: string; value: string }[];
			}) => Promise<unknown>;
		};
	};
	params?: unknown;
	path: string;
}

/**
 * Better Auth hands endpoint hooks and handlers the route template as
 * `ctx.path` (`/sso/callback/:providerId`), with the id in `ctx.params`.
 */
const SSO_CALLBACK_ROUTES = new Set([
	"/sso/callback/:providerId",
	"/sso/saml2/callback/:providerId",
	"/sso/saml2/sp/acs/:providerId",
]);

const callbackParams = z
	.object({ providerId: z.string().min(1) })
	.nullable()
	.catch(null);

/**
 * The provider id of a provider-specific SSO callback, from the route template
 * and its params, or from a concrete request path.
 */
export function providerIdFromSsoCallbackContext(
	ctx: Pick<SsoProvisioningContext, "params" | "path">
): string | null {
	if (SSO_CALLBACK_ROUTES.has(ctx.path)) {
		return callbackParams.parse(ctx.params ?? null)?.providerId ?? null;
	}
	return providerIdFromSsoCallbackPath(ctx.path);
}

const organizationSsoProvider = z
	.object({
		domain: z.string().min(1),
		domainVerified: z.literal(true),
		organizationId: z.string().min(1),
	})
	.nullable()
	.catch(null);

const createdUser = z
	.object({ email: z.string().min(1) })
	.nullable()
	.catch(null);

/** One entry of a provider's comma-separated `domain`, as a bare hostname. */
function providerDomainHostname(entry: string): string | null {
	try {
		const url = new URL(entry.includes("://") ? entry : `https://${entry}`);
		return url.hostname.toLowerCase() || null;
	} catch {
		return null;
	}
}

/**
 * True when `email` belongs to one of the provider's domains: an exact or
 * subdomain match against its comma-separated list, as `@better-auth/sso`'s
 * `validateEmailDomain` decides whether a provider is trusted. Any unparsable
 * entry rejects the whole list.
 */
export function emailInProviderDomain(email: string, domain: string): boolean {
	const at = email.lastIndexOf("@");
	const emailDomain =
		at === -1
			? ""
			: email
					.slice(at + 1)
					.trim()
					.toLowerCase();
	if (!emailDomain) {
		return false;
	}
	const entries = domain
		.split(",")
		.map((entry) => entry.trim())
		.filter(Boolean);
	if (entries.length === 0) {
		return false;
	}
	const hostnames: string[] = [];
	for (const entry of entries) {
		const hostname = providerDomainHostname(entry);
		if (!hostname) {
			return false;
		}
		hostnames.push(hostname);
	}
	return hostnames.some(
		(hostname) =>
			emailDomain === hostname || emailDomain.endsWith(`.${hostname}`)
	);
}

/**
 * True when `user` is being created by just-in-time provisioning on the SSO
 * callback of an organization's verified-domain identity provider, for an
 * email inside that verified domain.
 *
 * That provisioning is the organization's responsibility, exactly like SCIM
 * and admin creation, so the public sign-up age screen does not apply. The
 * IdP's SAML POST is cross-site, so the SameSite=Lax age cookie never arrives
 * there anyway. Only provider-specific callback paths qualify, only for a
 * provider bound to an organization whose domain is verified, and only for a
 * user whose email is in that domain: a multi-tenant IdP (a public Google
 * client, Entra `common`) can assert any email, and the organization vouches
 * only for its own. A personal or unverified provider, an email outside the
 * domain, a missing user, social OAuth, and every other path stay gated.
 */
export async function isOrganizationSsoProvisioning(
	ctx: SsoProvisioningContext,
	user?: unknown
): Promise<boolean> {
	const email = createdUser.parse(user ?? null)?.email;
	if (!email) {
		return false;
	}
	const providerId = providerIdFromSsoCallbackContext(ctx);
	if (!providerId) {
		return false;
	}
	const provider = organizationSsoProvider.parse(
		await ctx.context.adapter.findOne({
			model: "ssoProvider",
			where: [{ field: "providerId", value: providerId }],
		})
	);
	return provider !== null && emailInProviderDomain(email, provider.domain);
}
