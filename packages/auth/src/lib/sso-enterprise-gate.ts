import type { EnterpriseCapability } from "./enterprise-entitlement-policy.ts";

interface SsoProviderReference {
	providerId: string;
	source: { recordId: string; type: "persisted" } | { type: "configured" };
}

interface SsoEnterpriseResolutionInput {
	protocol: "oidc" | "saml";
	providerId: string;
	providerReference: SsoProviderReference;
}

interface SsoEnterpriseDatabase {
	findOne(input: {
		model: string;
		where: { field: string; value: string }[];
	}): Promise<unknown>;
}

export type EnterpriseSsoResolution =
	| { action: "continue" }
	| { action: "reject"; code: string; message: string };

const denied = (): EnterpriseSsoResolution => ({
	action: "reject",
	code: "ENTERPRISE_SSO_INACTIVE",
	message: "This organization's Enterprise SSO access is inactive.",
});

const OBJECT_ID_HEX = /^[0-9a-f]{24}$/i;

/**
 * The provider's organization id. Better Auth declares
 * `ssoProvider.organizationId` as a plain string, so the adapter stores and
 * returns the organization's hex id; a row written with a BSON ObjectId (by an
 * import or a manual repair) still names the same organization, so its hex
 * form is accepted too. Anything else names no organization.
 */
function organizationIdOf(value: unknown): string {
	if (typeof value === "string") {
		return value.trim();
	}
	if (
		typeof value === "object" &&
		value !== null &&
		"toHexString" in value &&
		typeof value.toHexString === "function"
	) {
		const hex: unknown = value.toHexString();
		return typeof hex === "string" && OBJECT_ID_HEX.test(hex) ? hex : "";
	}
	return "";
}

/**
 * Resolve the exact locked provider record to its organization and enforce the
 * live protocol entitlement before Better Auth creates an account or session.
 */
export async function resolveEnterpriseSsoUser(
	input: SsoEnterpriseResolutionInput,
	database: SsoEnterpriseDatabase,
	checkCapability: (
		organizationId: string,
		capability: EnterpriseCapability
	) => Promise<boolean>
): Promise<EnterpriseSsoResolution> {
	if (input.providerReference.source.type !== "persisted") {
		return denied();
	}
	try {
		const provider = (await database.findOne({
			model: "ssoProvider",
			where: [
				{
					field: "id",
					value: input.providerReference.source.recordId,
				},
				{ field: "providerId", value: input.providerId },
			],
		})) as { organizationId?: unknown } | null;
		const organizationId = organizationIdOf(provider?.organizationId);
		if (!organizationId) {
			return denied();
		}
		const capability: EnterpriseCapability =
			input.protocol === "saml" ? "enterprise.sso.saml" : "enterprise.sso.oidc";
		return (await checkCapability(organizationId, capability))
			? { action: "continue" }
			: denied();
	} catch {
		return denied();
	}
}
