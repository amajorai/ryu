// Zod codecs for the Core vault replies decoded by `vault.ts`. Listing and
// audit replies carry metadata only; plaintext arrives only through reveal.

import { appResponseValueSchema } from "@ryuhq/core-client/app-request-json.ts";
import { z } from "zod";

export const vaultCallerContextResponseSchema = z
	.object({
		orgId: z.union([z.null(), z.string()]),
		role: z.union([
			z.literal("owner"),
			z.literal("admin"),
			z.literal("member"),
			z.literal("viewer"),
		]),
		teamIds: z.array(z.string()),
		userId: z.string(),
	})
	.passthrough();

export const vaultNodeContextResponseSchema = z
	.object({
		id: z.string(),
		orgId: z.union([z.null(), z.string()]),
		ownerUserId: z.union([z.null(), z.string()]),
		scope: z.union([
			z.literal("local"),
			z.literal("org"),
			z.literal("team"),
			z.literal("personal"),
		]),
		teamId: z.union([z.null(), z.string()]),
	})
	.passthrough();

export const vaultSealStatusResponseSchema = z
	.object({
		activeKeyVersion: z.number(),
		keyVersions: z.array(z.number()),
		mode: z.union([z.literal("auto"), z.literal("shamir")]),
		progress: z.number(),
		sealed: z.boolean(),
		shares: z.number(),
		threshold: z.number(),
	})
	.passthrough();

export const vaultSecretBindingResponseSchema = z
	.object({ id: z.string(), kind: z.literal("mcp") })
	.passthrough();

export const vaultGeneratorResponseSchema = z
	.object({
		charset: z.string(),
		kind: z.literal("random"),
		length: z.number(),
	})
	.passthrough();

export const vaultSecretMetadataResponseSchema = z
	.object({
		description: z.string(),
		expandReferences: z.boolean(),
		expiresAt: z.union([z.null(), z.string()]),
		generator: z.union([z.null(), vaultGeneratorResponseSchema]),
		maxVersions: z.number(),
		rotationPeriodSecs: z.union([z.null(), z.number()]),
		tags: z.array(z.string()),
	})
	.passthrough();

export const vaultSecretWireSchema = z
	.object({
		binding: vaultSecretBindingResponseSchema.optional(),
		capabilities: z
			.array(
				z.union([
					z.literal("admin"),
					z.literal("list"),
					z.literal("use"),
					z.literal("read"),
					z.literal("write"),
					z.literal("delete"),
					z.literal("approve"),
				])
			)
			.optional(),
		createdAt: z.union([z.null(), z.string()]).optional(),
		createdBy: z.union([z.null(), z.string()]).optional(),
		deletedAt: z.union([z.null(), z.string()]).optional(),
		environment: z.string().optional(),
		metadata: vaultSecretMetadataResponseSchema.partial().optional(),
		name: z.string().optional(),
		path: z.string().optional(),
		rotatedAt: z.union([z.null(), z.string()]).optional(),
		scope: z
			.union([
				z.literal("node"),
				z.literal("org"),
				z.literal("team"),
				z.literal("user"),
			])
			.optional(),
		scopeId: z.string().optional(),
		source: z.literal("control-plane").optional(),
		status: z
			.union([
				z.literal("active"),
				z.literal("expired"),
				z.literal("rotation_due"),
				z.literal("deleted"),
			])
			.optional(),
		updatedAt: z.string().optional(),
		updatedBy: z.union([z.null(), z.string()]).optional(),
		version: z.number().optional(),
	})
	.passthrough();

export const rawVaultStateResponseSchema = z
	.object({
		caller: z.union([z.null(), vaultCallerContextResponseSchema]),
		canManageShared: z.boolean(),
		node: vaultNodeContextResponseSchema,
		activeEnvironment: z.string().optional(),
		seal: z.union([z.null(), vaultSealStatusResponseSchema]).optional(),
		sharedError: z.union([z.null(), z.string()]).optional(),
		sharedRemote: z.boolean().optional(),
		secrets: z.array(vaultSecretWireSchema).optional(),
	})
	.passthrough();

export const vaultVersionResponseSchema = z
	.object({
		createdAt: z.string(),
		createdBy: z.union([z.null(), z.string()]),
		current: z.boolean(),
		destroyed: z.boolean(),
		source: z.string(),
		version: z.number(),
	})
	.passthrough();

export const listVaultVersionsResponseSchema = z
	.object({ versions: z.array(vaultVersionResponseSchema).optional() })
	.passthrough();

export const vaultExportResultResponseSchema = z
	.object({
		content: z.string(),
		contentType: z.string(),
		count: z.number(),
		environment: z.string(),
		format: z.union([
			z.literal("dotenv"),
			z.literal("json"),
			z.literal("yaml"),
			z.literal("shell"),
			z.literal("k8s-secret"),
		]),
		path: z.string(),
		sharedError: z.string().nullish(),
	})
	.passthrough();

export const vaultImportReportResponseSchema = z
	.object({
		created: z.number(),
		skipped: z.number(),
		unchanged: z.number(),
		updated: z.number(),
	})
	.passthrough();

export const importVaultSecretsResponseSchema = z
	.object({ report: vaultImportReportResponseSchema.optional() })
	.passthrough();

export const vaultEnvironmentResponseSchema = z
	.object({
		name: z.string(),
		position: z.number(),
		protected: z.boolean(),
		requiredApprovals: z.number(),
		slug: z.string(),
	})
	.passthrough();

export const listVaultEnvironmentsResponseSchema = z
	.object({
		active: z.string().optional(),
		environments: z.array(vaultEnvironmentResponseSchema).optional(),
	})
	.passthrough();

export const listVaultFoldersResponseSchema = z
	.object({ folders: z.array(z.string()).optional() })
	.passthrough();

export const vaultAuditVerifyReportResponseSchema = z
	.object({
		firstBadSeq: z.number().optional(),
		ok: z.boolean(),
		rows: z.number(),
	})
	.passthrough();

export const verifyVaultAuditResponseSchema = z
	.object({ report: vaultAuditVerifyReportResponseSchema })
	.passthrough();

export const vaultSysStatusResponseSchema = z
	.object({
		activeEnvironment: z.string(),
		seal: vaultSealStatusResponseSchema,
		sharedRemote: z.boolean(),
	})
	.passthrough();

export const sealVaultResponseSchema = z
	.object({ seal: vaultSealStatusResponseSchema })
	.passthrough();

export const unsealVaultResponseSchema = z
	.object({ seal: vaultSealStatusResponseSchema })
	.passthrough();

export const vaultChangeApprovalSchema = z
	.object({ at: z.union([z.string(), z.number()]), by: z.string() })
	.passthrough();

export const vaultChangeBindingSchema = z
	.object({ id: z.string(), kind: z.literal("mcp") })
	.passthrough();

export const vaultChangeCoordsSchema = z
	.object({
		binding: vaultChangeBindingSchema.optional(),
		environment: z.string(),
		name: z.string(),
		path: z.string(),
		scope: z.union([
			z.literal("user"),
			z.literal("node"),
			z.literal("team"),
			z.literal("org"),
		]),
		scopeId: z.string(),
	})
	.passthrough();

export const vaultChangeRequestResponseSchema = z
	.object({
		approvals: z.array(vaultChangeApprovalSchema),
		coords: vaultChangeCoordsSchema,
		decidedAt: z.union([z.null(), z.string()]),
		decidedBy: z.union([z.null(), z.string()]),
		hasValue: z.boolean(),
		id: z.string(),
		operation: z.union([z.literal("write"), z.literal("delete")]),
		patch: appResponseValueSchema.nonoptional(),
		reason: z.union([z.null(), z.string()]),
		requestedAt: z.string(),
		requestedBy: z.string(),
		requiredApprovals: z.number(),
		status: z.union([
			z.literal("pending"),
			z.literal("applied"),
			z.literal("rejected"),
			z.literal("canceled"),
		]),
	})
	.passthrough();

export const rawWriteResponseSchema = z
	.object({
		changeRequest: vaultChangeRequestResponseSchema.optional(),
		secret: vaultSecretWireSchema.optional(),
	})
	.passthrough();

export const listVaultChangeRequestsResponseSchema = z
	.object({
		changeRequests: z.array(vaultChangeRequestResponseSchema).optional(),
	})
	.passthrough();

export const decideVaultChangeRequestResponseSchema = z
	.object({ changeRequest: vaultChangeRequestResponseSchema.optional() })
	.passthrough();

export const listVaultAuditResponseEventsItemActorSchema = z
	.object({ id: z.union([z.null(), z.string()]), kind: z.string() })
	.passthrough();

export const vaultAuditEventResponseSchema = z
	.object({
		action: z.string(),
		actor: listVaultAuditResponseEventsItemActorSchema,
		at: z.string(),
		details: appResponseValueSchema.nonoptional(),
		environment: z.string().optional(),
		name: z.string().optional(),
		outcome: z.string(),
		path: z.string().optional(),
		requestId: z.string().optional(),
		scope: z.string().optional(),
		scopeId: z.string().optional(),
		seq: z.number(),
	})
	.passthrough();

export const listVaultAuditResponseSchema = z
	.object({
		events: z.array(vaultAuditEventResponseSchema).optional(),
		nextBefore: z.union([z.null(), z.number()]).optional(),
	})
	.passthrough();

// Core's reveal response contains a plaintext string; malformed/missing replies
// keep the existing caller-facing failure rather than exposing a parser error.
export const revealReplySchema = z
	.object({ value: z.string().optional() })
	.nullish();
// server/vault_api.rs emits {ok:true,destroyed:usize}. Older/no-content replies
// may omit the count; decoding does not impose JavaScript's safe-integer cap.
export const destroyReplySchema = z
	.object({
		destroyed: z
			.number()
			.refine((count) => Number.isInteger(count) && count >= 0)
			.optional(),
		ok: z.boolean().optional(),
	})
	.nullish();
