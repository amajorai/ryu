/**
 * Keep SCIM from writing a platform-admin address onto an account.
 *
 * A SCIM token belongs to one organization's directory, and the directory
 * decides the email of every account it creates or manages; nothing checks
 * that the address belongs to the organization. An `ADMIN_EMAILS` address is
 * platform staff, never a customer directory's to assign. Left open, an
 * organization could pre-create an account for an allowlisted address that
 * has no Ryu account yet, wait for the real owner to verify the mailbox on it
 * (which earns the platform-admin role), and keep control of the account
 * through the directory. So SCIM may not:
 *   - create an account for an allowlisted address, or
 *   - rename an account it manages to an allowlisted address.
 *
 * A SCIM write that leaves an existing account's address unchanged passes, so
 * the directory can still deactivate and delete an account it holds. The
 * reverse direction (renaming an admin away from its verified address) is
 * handled inside the SCIM transaction by `reconcileScimAdminRole`.
 */

import type { BetterAuthPlugin } from "better-auth";
import { APIError } from "better-auth/api";
import { assertScimEmailOnVerifiedDomain } from "./scim-email-domain-guard.ts";
import type { OrganizationDomainsLookup } from "./sso-email-domain.ts";
import { isAdminEmail } from "./waitlist.ts";

export const SCIM_ADMIN_EMAIL_REFUSED = "SCIM_ADMIN_EMAIL_REFUSED";

const SCIM_PATH_PREFIX = "/scim/v2/";

/** True when the request is one of the SCIM 2.0 provisioning endpoints. */
export function isScimProvisioningPath(path: unknown): boolean {
	return typeof path === "string" && path.startsWith(SCIM_PATH_PREFIX);
}

/**
 * True when a SCIM create would give a new account an allowlisted address.
 * SCIM never proves a mailbox, so only a verified flag would let it pass.
 */
export function scimCreatesAdminEmail(
	path: unknown,
	user: { email?: unknown; emailVerified?: unknown }
): boolean {
	return (
		isScimProvisioningPath(path) &&
		typeof user.email === "string" &&
		isAdminEmail(user.email) &&
		user.emailVerified !== true
	);
}

/**
 * True when a SCIM update moves an account to an allowlisted address. Better
 * Auth's SCIM plugin sends the email on every managed profile update and adds
 * `emailVerified: false` only when the address changes, so an update that
 * keeps the current address passes.
 */
export function scimRenamesToAdminEmail(
	path: unknown,
	data: { email?: unknown; emailVerified?: unknown }
): boolean {
	return (
		isScimProvisioningPath(path) &&
		typeof data.email === "string" &&
		isAdminEmail(data.email) &&
		data.emailVerified === false
	);
}

/**
 * True when a SCIM update moves an account to a new address. The SCIM plugin
 * adds `emailVerified: false` only when the address changes.
 */
export function scimChangesEmail(
	path: unknown,
	data: { email?: unknown; emailVerified?: unknown }
): boolean {
	return (
		isScimProvisioningPath(path) &&
		typeof data.email === "string" &&
		data.emailVerified === false
	);
}

function refusal(): APIError {
	return new APIError("FORBIDDEN", {
		code: SCIM_ADMIN_EMAIL_REFUSED,
		message:
			"Directory sync cannot provision a platform administrator's address.",
	});
}

/**
 * Better Auth plugin that applies the guard to every SCIM user write, together
 * with the verified-domain binding in `scim-email-domain-guard.ts`: a SCIM
 * create, or a SCIM rename to a new address, must land on a DNS-verified SSO
 * domain the connection's organization still holds. `findOrganizationDomains`
 * defaults to the Mongoose read of `verifiedDomains`; tests inject one.
 */
export function scimAdminEmailGuardPlugin(
	options: { findOrganizationDomains?: OrganizationDomainsLookup } = {}
): BetterAuthPlugin {
	const { findOrganizationDomains } = options;
	return {
		id: "ryu-scim-admin-email-guard",
		init: () => ({
			options: {
				databaseHooks: {
					user: {
						create: {
							before: async (user, ctx) => {
								if (scimCreatesAdminEmail(ctx?.path, user)) {
									throw refusal();
								}
								if (isScimProvisioningPath(ctx?.path)) {
									await assertScimEmailOnVerifiedDomain(
										user.email,
										ctx,
										findOrganizationDomains
									);
								}
							},
						},
						update: {
							before: async (data, ctx) => {
								if (scimRenamesToAdminEmail(ctx?.path, data)) {
									throw refusal();
								}
								if (scimChangesEmail(ctx?.path, data)) {
									await assertScimEmailOnVerifiedDomain(
										data.email,
										ctx,
										findOrganizationDomains
									);
								}
							},
						},
					},
				},
			},
		}),
	};
}
