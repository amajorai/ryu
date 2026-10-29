import { z } from "zod";
export const ENTERPRISE_CAPABILITIES = [
	"enterprise.sso.oidc",
	"enterprise.sso.saml",
	"enterprise.scim",
	"enterprise.audit.export",
	"enterprise.deployment.dedicated",
	"enterprise.data.region",
] as const;

export type EnterpriseCapability = (typeof ENTERPRISE_CAPABILITIES)[number];
export type EnterpriseGrantStatus =
	| "active"
	| "expired"
	| "suspended"
	| "trialing";

export const normalizeEnterpriseCapabilities = z
	.array(z.enum(ENTERPRISE_CAPABILITIES).nullable().catch(null))
	.catch(() => [])
	.transform((capabilities) =>
		capabilities.filter((capability) => capability !== null)
	).parse;

export function isEnterpriseGrantActive(
	status: EnterpriseGrantStatus,
	expiresAt: Date | null,
	now = new Date()
): boolean {
	return (
		(status === "active" || status === "trialing") &&
		(!expiresAt || expiresAt.getTime() > now.getTime())
	);
}
