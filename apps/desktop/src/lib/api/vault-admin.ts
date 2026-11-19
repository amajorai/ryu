// Vault administration reads the Vault page shows: external audit devices
// (`admin` on `sys/audit`) and control-group requests the caller opened or may
// approve. Neither route returns a value or a redemption token; devices carry
// their delivery health.

import type {
	VaultAuditDeviceListing,
	VaultControlGroup,
} from "@ryuhq/core-client/vault.ts";
import { z } from "zod";
import { type ApiTarget, request } from "./client.ts";

export type {
	VaultAuditDeviceListing,
	VaultControlGroup,
} from "@ryuhq/core-client/vault.ts";

const timestamp = z.union([z.string(), z.number()]);

const deviceSchema = z
	.object({
		description: z.string(),
		enabled: z.boolean(),
		health: z
			.object({
				failing: z.boolean(),
				lastError: z.string().optional(),
				lastErrorAt: timestamp.optional(),
				lastOkAt: timestamp.optional(),
			})
			.passthrough(),
		hmacFields: z.boolean(),
		id: z.string(),
		kind: z.enum(["file", "syslog", "socket", "http"]),
		options: z.unknown(),
		source: z.string(),
	})
	.passthrough();

const devicesSchema = z.object({
	devices: z.array(deviceSchema),
	failClosed: z.boolean(),
});

const controlGroupSchema = z
	.object({
		approvals: z.array(
			z.object({
				approvedAt: timestamp,
				approver: z.string(),
				factor: z.string(),
			})
		),
		createdAt: timestamp,
		expiresAt: timestamp,
		factors: z.array(
			z.object({
				approvals: z.number(),
				approvers: z.array(z.string()),
				name: z.string(),
			})
		),
		id: z.string(),
		policyKey: z.string(),
		redeemedAt: timestamp.optional(),
		requester: z.string(),
		status: z.enum(["pending", "approved", "redeemed", "expired"]),
		target: z.unknown(),
	})
	.passthrough();

export interface VaultAuditDevices {
	devices: VaultAuditDeviceListing[];
	failClosed: boolean;
}

export async function listVaultAuditDevices(
	target: ApiTarget
): Promise<VaultAuditDevices> {
	const raw = await request(
		target,
		"/api/vault/audit/devices",
		undefined,
		devicesSchema
	);
	// SAFETY: the schema checks every field the type names.
	return raw as VaultAuditDevices;
}

export async function listVaultControlGroups(
	target: ApiTarget
): Promise<VaultControlGroup[]> {
	const raw = await request(
		target,
		"/api/vault/control-groups",
		undefined,
		z.object({ controlGroups: z.array(controlGroupSchema) })
	);
	// SAFETY: the schema checks every field the type names.
	return raw.controlGroups as VaultControlGroup[];
}

/** Approve as the signed-in user; Core records the factors the caller satisfies. */
export async function authorizeVaultControlGroup(
	target: ApiTarget,
	id: string
): Promise<VaultControlGroup> {
	const raw = await request(
		target,
		`/api/vault/control-groups/${encodeURIComponent(id)}/authorize`,
		{ body: {}, method: "POST" },
		z.object({ controlGroup: controlGroupSchema })
	);
	// SAFETY: the schema checks every field the type names.
	return raw.controlGroup as VaultControlGroup;
}

/** Approvals each factor still needs, counting distinct approvers. */
export function controlGroupProgress(
	group: VaultControlGroup
): { factor: string; given: number; required: number }[] {
	return group.factors.map((factor) => ({
		factor: factor.name,
		given: Math.min(
			new Set(
				group.approvals
					.filter((approval) => approval.factor === factor.name)
					.map((approval) => approval.approver)
			).size,
			factor.approvals
		),
		required: factor.approvals,
	}));
}
