import {
	REPORT_REASONS,
	REPORT_SOURCES,
	type SubmitReportInput,
} from "@ryu/marketplace/report/types";
import { appResponseValueSchema } from "@ryuhq/core-client/app-request-json";
import { z } from "zod";

/** The real JSON HTTP carrier, preserving raw keys, arrays and references. */
export const storeProofJsonSchema = appResponseValueSchema;
export type StoreProofJson = z.output<typeof storeProofJsonSchema>;
function preserveStoreWire<S extends z.ZodType>(fields: S) {
	return z.custom<z.output<S>>(
		(value) =>
			storeProofJsonSchema.safeParse(value).success &&
			fields.safeParse(value).success
	);
}

// These are complete bodies emitted by their native Desktop API methods. The
// request's business-value validation remains Core-owned; future fields survive.
export const storeNameRequestSchema = preserveStoreWire(
	z.looseObject({ name: z.string() })
);
export const storeVariantRequestSchema = preserveStoreWire(
	z.looseObject({ variant: z.string() })
);
export const storePreferenceRequestSchema = preserveStoreWire(
	z.looseObject({ value: z.string() })
);
export const storeSourceSelectionSchema = preserveStoreWire(
	z.looseObject({ id: z.string(), kind: z.string() })
);
export const storeSourceMutationSchema = preserveStoreWire(
	z.looseObject({
		id: z.string(),
		kind: z.string().optional(),
		base_url: z.string().optional(),
		display_name: z.string().optional(),
		direction: z.enum(["up", "down"]).optional(),
		auth: z.looseObject({ bearer: z.string().optional() }).optional(),
	})
);
export const storeSourceReorderSchema = preserveStoreWire(
	z.looseObject({
		direction: z.enum(["up", "down"]),
		id: z.string(),
		kind: z.string(),
	})
);
export const storeRecommendationPreferenceSchema = preserveStoreWire(
	z.looseObject({ hidden: z.boolean().optional() })
);
export const storeLikesBatchSchema = preserveStoreWire(
	z.looseObject({ namespaces: z.array(z.string()).optional() })
);
export const storeLikeRequestSchema = preserveStoreWire(
	z.looseObject({ namespace: z.string() })
);
export const storeReviewRequestSchema = preserveStoreWire(
	z.looseObject({
		body: z.string().optional(),
		id: z.string(),
		kind: z.string(),
		rating: z.number(),
		title: z.string().optional(),
	})
);
export const storeModelInstallSchema = preserveStoreWire(
	z.looseObject({
		file: z.string().optional(),
		format: z.string().optional(),
		id: z.string(),
		dryRun: z.boolean().optional(),
	})
);
export const storeSkillDistributionSchema = preserveStoreWire(
	z.looseObject({
		rememberTargetIds: z.boolean().optional(),
		targetIds: z.array(z.string()),
	})
);
export const storeSkillActivationSchema = preserveStoreWire(
	z.looseObject({ active: z.boolean(), id: z.string() })
);
export const storeSkillInstallSchema = preserveStoreWire(
	z.looseObject({
		id: z.string(),
		dryRun: z.boolean().optional(),
		promptForTargets: z.boolean().optional(),
		rememberTargetIds: z.boolean().optional(),
		targetIds: z.array(z.string()).optional(),
	})
);
export const storeIdRequestSchema = preserveStoreWire(
	z.looseObject({ id: z.string() })
);
export const storePluginUpdateSchema = preserveStoreWire(
	z.looseObject({
		channel: z.string().nullable().optional(),
		version: z.string().optional(),
	})
);
export const storePluginInstallSchema = preserveStoreWire(
	z.looseObject({
		channel: z.string().nullable().optional(),
		id: z.string(),
		version: z.string().optional(),
	})
);
export const storeUrlInstallSchema = preserveStoreWire(
	z.looseObject({ url: z.string() })
);

const storeReportFieldsSchema = z.looseObject({
	details: z.string().nullable().optional(),
	homepage: z.string().nullable().optional(),
	id: z.string(),
	installSource: z.string().nullable().optional(),
	itemName: z.string().nullable().optional(),
	kind: z.string(),
	reason: z.enum(REPORT_REASONS),
	source: z.enum(REPORT_SOURCES).optional(),
}) satisfies z.ZodType<SubmitReportInput>;
export const storeReportInputSchema = z.custom<SubmitReportInput>(
	(value) =>
		storeProofJsonSchema.safeParse(value).success &&
		storeReportFieldsSchema.safeParse(value).success
);
const storeEffectsFieldsSchema = z.looseObject({
	openedExternalUrls: z.array(z.string()),
	openedAuditConversations: z.array(z.string()),
	openedSettings: z.array(z.string()),
	openedTabs: z.array(z.string()),
	submittedReports: z.array(storeReportInputSchema),
});
export const storeEffectsSchema = preserveStoreWire(storeEffectsFieldsSchema);
export type StoreHomeEffects = z.output<typeof storeEffectsSchema>;

/** Actual native CustomEvent admission precedes its owned detail decoding. */
export function storeStringEventDetail(event: Event): string {
	if (!(event instanceof CustomEvent)) {
		throw new Error("Marketplace Store event must be a native CustomEvent");
	}
	return z.string().parse(event.detail);
}
export function storeReportEventDetail(event: Event): SubmitReportInput {
	if (!(event instanceof CustomEvent)) {
		throw new Error("Marketplace report event must be a native CustomEvent");
	}
	return storeReportInputSchema.parse(event.detail);
}

/** The real published policy; this is not a claim about the entire Gateway PUT. */
export const gatewayMarketplacePolicySchema = z.looseObject({
	cadence: z.enum(["daily", "weekly", "monthly"]),
	enabled: z.boolean(),
}) satisfies z.ZodType<
	NonNullable<
		import("../src/lib/api/gateway.ts").GatewayConfigPatch["marketplace_recommendations"]
	>
>;
const marketplaceObservationFields = z.object({
	cadence: storeProofJsonSchema.optional(),
	enabled: storeProofJsonSchema.optional(),
});
export type GatewayMarketplaceUpdateObservation = z.output<
	typeof marketplaceObservationFields
>;
const gatewayObservationFields = z.object({
	marketplace_recommendations: storeProofJsonSchema.optional(),
});
/** A complete consumed-policy observation over native JSON, preserving the
 * fixture's legacy truthy cadence semantics without claiming a full Gateway DTO. */
export function gatewayMarketplaceUpdateObservation(
	body: StoreProofJson
): GatewayMarketplaceUpdateObservation {
	if (body === null || body === undefined) {
		throw new TypeError(
			`Cannot read properties of ${body} (reading 'marketplace_recommendations')`
		);
	}
	const outer = gatewayObservationFields.safeParse(body);
	const policy = marketplaceObservationFields.safeParse(
		outer.success ? outer.data.marketplace_recommendations : undefined
	);
	return policy.success ? policy.data : {};
}
