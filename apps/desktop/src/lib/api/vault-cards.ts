// Payment card spend approvals (`/api/vault/cards/approvals*`). Approval
// requests carry the card's brand, last four digits, and merchant host, never
// the card number or security code.

import { appResponseValueSchema } from "@ryuhq/core-client/app-request-json.ts";
import { z } from "zod";
import { type ApiTarget, request } from "./client.ts";
import { vaultQueryString } from "./vault-query.ts";

export interface VaultCardApproval {
	agent: string;
	brand?: string;
	channel: "broker" | "fill" | "reveal";
	environment: string;
	/** The field a reveal asks for (`number` or `cvc`); absent otherwise. */
	field?: "number" | "cvc";
	id: string;
	key: string;
	last4?: string;
	merchantHost: string;
	requestExpiresAt: string;
	requestedAt: string;
	requester: string;
	status:
		| "pending"
		| "approved"
		| "rejected"
		| "expired"
		| "consumed"
		| "revoked";
}

const vaultCardApprovalResponseSchema = z
	.object({
		agent: z.string(),
		brand: z.string().optional(),
		channel: z.union([
			z.literal("broker"),
			z.literal("fill"),
			z.literal("reveal"),
		]),
		environment: z.string(),
		field: z.union([z.literal("number"), z.literal("cvc")]).optional(),
		id: z.string(),
		key: z.string(),
		last4: z.string().optional(),
		merchantHost: z.string(),
		requestExpiresAt: z.string(),
		requestedAt: z.string(),
		requester: z.string(),
		status: z.union([
			z.literal("pending"),
			z.literal("approved"),
			z.literal("rejected"),
			z.literal("expired"),
			z.literal("consumed"),
			z.literal("revoked"),
		]),
	})
	.passthrough();

const listVaultCardApprovalsResponseSchema = z
	.object({ approvals: z.array(vaultCardApprovalResponseSchema).optional() })
	.passthrough();

export async function listVaultCardApprovals(
	target: ApiTarget
): Promise<VaultCardApproval[]> {
	const raw = await request(
		target,
		`/api/vault/cards/approvals${vaultQueryString({ status: "pending" })}`,
		undefined,
		listVaultCardApprovalsResponseSchema
	);
	return raw?.approvals ?? [];
}

/** `once` releases one use; `grant` lets the requesting session use the card
 *  at that merchant until `ttlSecs` (default 15 minutes) runs out. */
export type VaultCardDecision = "reject" | "once" | "grant";

export async function decideVaultCardApproval(
	target: ApiTarget,
	id: string,
	decision: VaultCardDecision
): Promise<void> {
	const path = `/api/vault/cards/approvals/${encodeURIComponent(id)}`;
	if (decision === "reject") {
		await request(
			target,
			`${path}/reject`,
			{ body: {}, method: "POST" },
			appResponseValueSchema
		);
		return;
	}
	await request(
		target,
		`${path}/approve`,
		{
			body:
				decision === "grant"
					? { mode: "grant", subject: "session", ttlSecs: 900 }
					: { mode: "once" },
			method: "POST",
		},
		appResponseValueSchema
	);
}
