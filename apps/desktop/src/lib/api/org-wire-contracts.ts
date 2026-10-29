import { z } from "zod";
import {
	pluginDocumentSchema,
	pluginValueSchema,
} from "./plugin-wire-values.ts";

/** Complete control-plane and credits DTOs retain additive JSON metadata. */
function orgWireRecord<S extends z.ZodObject>(fields: S) {
	return z.custom<z.output<S>>(
		(value) =>
			pluginDocumentSchema.safeParse(value).success &&
			fields.safeParse(value).success
	);
}
export const orgSummarySchema = orgWireRecord(
	z.object({
		canSendFrom: z.boolean(),
		id: z.string(),
		isPersonal: z.boolean(),
		name: z.string(),
		role: z.string().nullable(),
		slug: z.string(),
	})
);
export const transferableGrantSchema = orgWireRecord(
	z.object({
		expiresAt: z.string().nullable(),
		id: z.string(),
		originalMicroUsd: z.number(),
		pool: z.string(),
		remainingMicroUsd: z.number(),
	})
);
export const organizationGatewayActivityEntrySchema = orgWireRecord(
	z.object({
		actorId: z.string().nullable(),
		agentId: z.string().nullable(),
		apiKey: z.string().nullable(),
		backend: z.string().nullable(),
		command: z.string().nullable(),
		costMicroUsd: z.number().nullable(),
		durationMs: z.number().nullable(),
		error: z.string().nullable(),
		evalScore: z.number().nullable(),
		eventType: z.string(),
		feature: z.string().nullable(),
		gatewayId: z.string(),
		id: z.string(),
		inputTokens: z.number(),
		latencyMs: z.number(),
		managedInference: z.boolean(),
		model: z.string().nullish(),
		outputTokens: z.number(),
		projectId: z.string().nullable(),
		provider: z.string(),
		providerCostMicroUsd: z.number().nullable(),
		requestId: z.string(),
		sessionId: z.string().nullable(),
		teamId: z.string().nullable(),
		timestamp: z.string(),
		userName: z.string().nullable(),
		widgetInstanceId: z.string().nullish(),
	})
);
export const transferResultSchema = orgWireRecord(
	z.object({
		movedGrantIds: z.array(z.string()),
		movedGrantMicroUsd: z.number(),
		movedTopupMicroUsd: z.number(),
		ok: z.boolean(),
		reason: z.string().nullable(),
	})
);
export const organizationAuditEntrySchema = orgWireRecord(
	z.object({
		action: z.string(),
		actor: orgWireRecord(
			z.object({
				email: z.string().nullable(),
				id: z.string().nullable(),
				name: z.string().nullable(),
				type: z.enum(["gateway", "system", "user"]),
			})
		),
		agentId: z.string().nullable(),
		details: pluginDocumentSchema,
		error: z.string().nullable(),
		eventType: z.string(),
		feature: z.string().nullable(),
		id: z.string(),
		requestId: z.string().nullable(),
		scope: z.enum(["gateway", "org"]),
		sessionId: z.string().nullable(),
		target: z.string(),
		targetId: z.string().nullable(),
		timestamp: z.string(),
	})
);
export const transferableViewSchema = orgWireRecord(
	z.object({
		orgs: z.array(orgSummarySchema),
		source: orgWireRecord(
			z.object({
				grants: z.array(transferableGrantSchema),
				orgId: z.string(),
				topupMicroUsd: z.number(),
			})
		).nullable(),
	})
);
export const organizationActivityResponseSchema = orgWireRecord(
	z.object({
		count: z.number(),
		entries: z.array(organizationGatewayActivityEntrySchema),
	})
);
export const organizationControlsResponseSchema = orgWireRecord(
	z.object({
		count: z.number(),
		entries: z.array(organizationAuditEntrySchema),
	})
);
// Legacy control planes omit fields; listOrgs owns their normalization.
export const orgListResponseSchema = z.object({
	organizations: z
		.array(
			z.object({
				createdAt: z.string().nullish(),
				id: z.string().nullish(),
				isPersonal: z.boolean().nullish(),
				logo: z.string().nullish(),
				name: z.string().nullish(),
				role: z.string().nullish(),
				slug: z.string().nullish(),
			})
		)
		.nullish(),
});
/** Only the active-scope projection, not a full Better Auth session DTO. */
export const orgSessionOrganizationScopeSchema = z
	.object({
		session: z.object({ activeOrganizationId: z.string().nullish() }).nullish(),
	})
	.nullable();
export const orgSessionTeamScopeSchema = z
	.object({
		session: z.object({ activeTeamId: z.string().nullish() }).nullish(),
	})
	.nullable();
export const orgErrorProjectionSchema = z
	.object({ error: z.string().nullish(), message: z.string().nullish() })
	.nullable();
export const orgTeamProjectionSchema = z.object({
	id: z.string(),
	name: z.string(),
});
export const orgTeamsResponseSchema = z.array(pluginValueSchema);
