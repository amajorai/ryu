import { gatewayJsonValueSchema } from "@/src/lib/api/gateway-json-contracts.ts";
// apps/desktop/src/lib/api/org-features.ts
//
// Organization feature toggles as Core resolves them for the verified caller
// (`GET /api/gateway/org-features`). Core enforces the install/update toggles at
// its own routes; the desktop reads the same values only to hide or disable the
// matching controls, so a missing or older Core simply leaves everything on.

import { z } from "zod";
import { type ApiTarget, request } from "./client.ts";

/** Organization feature keys the desktop feature-detects. */
export type OrgFeatureKey =
	| "apps.install"
	| "apps.marketplace"
	| "engines.catalog"
	| "engines.update"
	| "plugins.marketplace";

export interface OrgFeatures {
	/** False when the node is org-bound but its feature policy is unknown. */
	available: boolean;
	features: Record<string, boolean>;
	/** True when this node is bound to an organization. */
	managed: boolean;
}

const orgFeaturesSchema = z.object({
	available: z.boolean().catch(true),
	features: z.record(z.string(), z.boolean()).catch({}),
	managed: z.boolean().catch(false),
});

export const UNMANAGED_ORG_FEATURES: OrgFeatures = {
	available: true,
	features: {},
	managed: false,
};

export const parseOrgFeatures = z.unknown().transform((value): OrgFeatures => {
	const parsed = orgFeaturesSchema.safeParse(value);
	return parsed.success ? parsed.data : UNMANAGED_ORG_FEATURES;
}).parse;

/**
 * Whether a feature is usable. Unmanaged nodes and keys the organization never
 * set stay enabled; an org-bound node whose policy could not be resolved is
 * treated as disabled because Core refuses the gated routes in that state.
 */
export const isOrgFeatureEnabled = (
	features: OrgFeatures,
	key: OrgFeatureKey
): boolean => {
	if (!features.managed) {
		return true;
	}
	if (!features.available) {
		return false;
	}
	return features.features[key] ?? true;
};

export const fetchOrgFeatures = async (
	target: ApiTarget,
	signal?: AbortSignal
): Promise<OrgFeatures> => {
	const raw = await request(
		target,
		"/api/gateway/org-features",
		{
			signal,
		},
		gatewayJsonValueSchema
	);
	return parseOrgFeatures(raw);
};
