import {
	EnterpriseEntitlement,
	type EnterpriseLicenseStatus,
} from "@ryu/db/models/enterprise-entitlement.model";
import { env } from "@ryu/env/server";
import {
	ENTERPRISE_CAPABILITIES,
	type EnterpriseCapability,
	isEnterpriseGrantActive,
	normalizeEnterpriseCapabilities,
} from "./enterprise-entitlement-policy.ts";
import { verifySelfHostedEnterpriseLicense } from "./enterprise-license.ts";
import {
	FAMILY_ORGANIZATION_KIND,
	readOrganizationKind,
} from "./organization-kind.ts";

export type { EnterpriseCapability } from "./enterprise-entitlement-policy.ts";
export {
	ENTERPRISE_CAPABILITIES,
	isEnterpriseGrantActive,
	normalizeEnterpriseCapabilities,
};

export interface EnterpriseAccess {
	capabilities: EnterpriseCapability[];
	expiresAt: Date | null;
	plan: "enterprise" | "enterprise-plus" | "dedicated" | null;
	source: "contract" | "development" | "self-host-license" | null;
	status: EnterpriseLicenseStatus | null;
}

/**
 * Development/test-only organization ids that receive Enterprise identity
 * capabilities without a contract record. Read from the raw process env, not
 * the production env schema, and ignored entirely in production.
 */
function parseDevelopmentOrganizationIds(): Set<string> {
	if (env.NODE_ENV === "production") {
		return new Set();
	}
	return new Set(
		(process.env.RYU_ENTERPRISE_ORG_IDS ?? "")
			.split(",")
			.map((value) => value.trim())
			.filter(Boolean)
	);
}

function emptyAccess(): EnterpriseAccess {
	return {
		capabilities: [],
		expiresAt: null,
		plan: null,
		source: null,
		status: null,
	};
}

/**
 * Resolve the active organization-level enterprise grant. Fail closed.
 *
 * A family workspace (Ryu Max family sharing) never has enterprise access,
 * whatever grant, license or development override names it: this is the
 * backstop behind the per-route family gates in the API, and it also covers
 * the consumers that only read capabilities (cloud nodes, data controls).
 */
export async function resolveEnterpriseAccess(
	organizationId: string
): Promise<EnterpriseAccess> {
	try {
		if (
			(await readOrganizationKind(organizationId)) === FAMILY_ORGANIZATION_KIND
		) {
			return emptyAccess();
		}
	} catch (error) {
		console.error(
			"[enterprise] failed to read organization kind; denying access:",
			error
		);
		return emptyAccess();
	}
	if (parseDevelopmentOrganizationIds().has(organizationId)) {
		return {
			capabilities: [...ENTERPRISE_CAPABILITIES],
			expiresAt: null,
			plan: "enterprise",
			source: "development",
			status: "active",
		};
	}

	try {
		const entitlement = await EnterpriseEntitlement.findOne({
			organizationId,
		})
			.lean()
			.exec();
		if (!entitlement) {
			const license = verifySelfHostedEnterpriseLicense(
				env.RYU_ENTERPRISE_LICENSE,
				env.RYU_ENTERPRISE_LICENSE_PUBLIC_KEY
			);
			if (license?.organizationId === organizationId) {
				return {
					capabilities: license.capabilities,
					expiresAt: license.expiresAt,
					plan: license.plan,
					source: "self-host-license",
					status: "active",
				};
			}
			return emptyAccess();
		}

		const expiresAt = entitlement.expiresAt
			? new Date(entitlement.expiresAt)
			: null;
		const active = isEnterpriseGrantActive(
			entitlement.status,
			expiresAt,
			new Date()
		);
		if (!active) {
			// Expiry is date-based: nothing rewrites the stored status, so a
			// lapsed `active`/`trialing` grant reports the effective `expired`
			// status. Status-only consumers must never read it as live.
			const storedStatus = entitlement.status ?? null;
			return {
				capabilities: [],
				expiresAt,
				plan: entitlement.plan ?? null,
				source: entitlement.source ?? null,
				status:
					storedStatus === "active" || storedStatus === "trialing"
						? "expired"
						: storedStatus,
			};
		}

		return {
			capabilities: normalizeEnterpriseCapabilities(entitlement.capabilities),
			expiresAt,
			plan: entitlement.plan ?? null,
			source: entitlement.source ?? null,
			status: entitlement.status ?? null,
		};
	} catch (error) {
		console.error(
			"[enterprise] failed to resolve organization entitlement; denying access:",
			error
		);
		return emptyAccess();
	}
}

export async function hasEnterpriseCapability(
	organizationId: string,
	capability: EnterpriseCapability
): Promise<boolean> {
	const access = await resolveEnterpriseAccess(organizationId);
	return access.capabilities.includes(capability);
}
