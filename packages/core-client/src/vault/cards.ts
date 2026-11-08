// packages/core-client/src/vault/cards.ts
//
// Payment cards: part of the Secret Vault client. `../vault.ts` re-exports
// these names and documents the wire conventions.

import { z } from "zod";
import { type ApiTarget, request } from "../client.ts";
import type { VaultAgentTarget } from "./agent-routes.ts";
import { vaultReply, vaultText } from "./codecs-machine.ts";
import {
	CARD_OPTIONAL_FIELDS,
	vaultCardApprovalReply,
	vaultCardApprovalsReply,
	vaultCardFillReply,
	vaultCardRevealReply,
} from "./codecs-reply.ts";
import {
	agentRequest,
	itemPath,
	query,
	type VaultCardPending,
} from "./internal.ts";
import {
	type PutVaultItemInput,
	putVaultItem,
	type VaultItem,
	type VaultItemLocation,
} from "./items.ts";
import type { VaultTimestamp } from "./shared.ts";

/** A new payment card. The number and CVC are sent once and never returned. */
export interface PutVaultCardInput extends VaultItemLocation {
	addressLine1?: string;
	addressLine2?: string;
	cardholder: string;
	city?: string;
	/** Two-letter ISO 3166 code. */
	country?: string;
	cvc?: string;
	description?: string;
	/** 1-12. */
	expMonth: string | number;
	/** YY or YYYY. */
	expYear: string | number;
	/** Merchant host patterns (`shop.example.com` or `*.example.com`). */
	merchants: string[];
	/** 12-19 digits; spaces and dashes are ignored; Luhn-checked by Core. */
	number: string;
	postalCode?: string;
	region?: string;
}

/** The `PUT /api/vault/items/{key}` body for a card. */
export function vaultCardItemInput(
	input: PutVaultCardInput
): PutVaultItemInput {
	const values: Record<string, string> = {
		cardholder: input.cardholder,
		number: input.number,
		expMonth: String(input.expMonth),
		expYear: String(input.expYear),
	};
	for (const name of CARD_OPTIONAL_FIELDS) {
		const value = input[name];
		if (value !== undefined && value !== "") {
			values[name] = value;
		}
	}
	const body: PutVaultItemInput = {
		kind: "card",
		merchants: input.merchants,
		values,
	};
	if (input.environment !== undefined) {
		body.environment = input.environment;
	}
	if (input.path !== undefined) {
		body.path = input.path;
	}
	if (input.description !== undefined) {
		body.description = input.description;
	}
	return body;
}

/** Create a payment card item (or confirm an identical one). */
export function putVaultCard(
	target: ApiTarget,
	key: string,
	input: PutVaultCardInput
): Promise<{ item: VaultItem }> {
	return putVaultItem(target, key, vaultCardItemInput(input));
}

export type VaultCardChannel = "broker" | "fill" | "reveal";

export type VaultCardApprovalStatus =
	| "pending"
	| "approved"
	| "rejected"
	| "expired"
	| "consumed"
	| "revoked";

/** A card spend approval request or grant. Never carries a card value. */
export interface VaultCardApproval {
	/** `machine:<id>`, `user:<id>`, or `operator`. */
	agent: string;
	brand?: string;
	channel: VaultCardChannel;
	decidedAt?: VaultTimestamp;
	decidedBy?: string;
	environment: string;
	/** The field a reveal asks for (`number` or `cvc`); absent otherwise. */
	field?: string;
	grantExpiresAt?: VaultTimestamp;
	grantSubject?: string;
	id: string;
	itemId: string;
	key: string;
	last4?: string;
	maxUses?: number;
	/** Empty for a reveal. */
	merchantHost: string;
	mode?: "once" | "grant";
	note?: string;
	path: string;
	requestExpiresAt: VaultTimestamp;
	requestedAt: VaultTimestamp;
	/** `broker_session:<id>`, `user:<id>`, or `operator`. */
	requester: string;
	status: VaultCardApprovalStatus;
	uses: number;
}

/** A human's approval: one use, or a grant for the requesting session (or
 *  its agent) at that merchant, for `ttlSecs` (60-86400, default 900; a
 *  `once` approval must also be used within it). */
export interface VaultCardApproveInput {
	maxUses?: number;
	mode?: "once" | "grant";
	note?: string;
	subject?: "session" | "agent";
	ttlSecs?: number;
}

/** A card use either releases values or answers `202` with the pending
 *  approval request a human must decide first. */
export type VaultCardUseResult<T> =
	| ({ status: "released" } & T)
	| {
			approval: VaultCardApproval;
			approvePath: string;
			status: "approval_required";
	  };

function isPending(value: unknown): value is VaultCardPending {
	return (
		typeof value === "object" &&
		value !== null &&
		"status" in value &&
		value.status === "approval_required"
	);
}

/** Fill a card into an allowlisted HTTPS origin (`use` and `read`: the reply
 *  carries the number and security code). Each fill needs a spend approval;
 *  without a live grant Core answers with a pending request. */
export async function fillVaultCard(
	target: ApiTarget,
	key: string,
	origin: string,
	location: VaultItemLocation = {}
): Promise<
	VaultCardUseResult<{
		approvalId: string;
		card: { brand?: string; last4?: string };
		fields: Record<string, string>;
		origin: string;
	}>
> {
	const reply = await request(
		target,
		itemPath(key, "/fill"),
		{ method: "POST", body: { ...location, origin } },
		vaultCardFillReply
	);
	return isPending(reply) ? reply : { status: "released", ...reply };
}

/** Reveal a card's number or CVC (`read`). Every reveal needs a single-use
 *  approval; the first call returns the pending request. */
export async function revealVaultCardField(
	target: ApiTarget,
	key: string,
	field: string,
	location: VaultItemLocation = {}
): Promise<VaultCardUseResult<{ field: string; value: string }>> {
	const reply = await request(
		target,
		itemPath(key, "/reveal"),
		{ method: "POST", body: { ...location, field } },
		vaultCardRevealReply
	);
	return isPending(reply) ? reply : { status: "released", ...reply };
}

function cardApprovalPath(id?: string, suffix = ""): string {
	return id === undefined
		? "/api/vault/cards/approvals"
		: `/api/vault/cards/approvals/${encodeURIComponent(id)}${suffix}`;
}

/** Card spend approvals the caller may see (`list` on the card). */
export function listVaultCardApprovals(
	target: ApiTarget,
	filter: { environment?: string; status?: VaultCardApprovalStatus } = {}
): Promise<{ approvals: VaultCardApproval[] }> {
	return request(
		target,
		`${cardApprovalPath()}${query({
			status: filter.status,
			environment: filter.environment,
		})}`,
		{},
		vaultCardApprovalsReply
	);
}

export function getVaultCardApproval(
	target: ApiTarget,
	id: string
): Promise<{ approval: VaultCardApproval }> {
	return request(target, cardApprovalPath(id), {}, vaultCardApprovalReply);
}

/** Approve (once or as a grant), reject a pending request, or revoke a
 *  grant. Needs `write` on the card. */
export function decideVaultCardApproval(
	target: ApiTarget,
	id: string,
	decision: "approve" | "reject" | "revoke",
	input: VaultCardApproveInput = {}
): Promise<{ approval: VaultCardApproval }> {
	const body: VaultCardApproveInput =
		decision === "approve" ? { ...input } : {};
	if (decision !== "approve" && input.note) {
		body.note = input.note;
	}
	return request(
		target,
		cardApprovalPath(id, `/${decision}`),
		{ method: "POST", body },
		vaultCardApprovalReply
	);
}

/** Poll an approval the agent's broker session (or machine) requested. */
export function vaultAgentCardApproval(
	target: VaultAgentTarget,
	id: string
): Promise<{ approval: Partial<VaultCardApproval> & { id: string } }> {
	return agentRequest(
		vaultReply<{ approval: Partial<VaultCardApproval> & { id: string } }>(
			z.object({ approval: z.object({ id: vaultText, status: vaultText }) })
		),
		target,
		`/api/vault/agent/cards/approvals/${encodeURIComponent(id)}`
	);
}
