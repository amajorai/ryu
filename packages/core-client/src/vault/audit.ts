// packages/core-client/src/vault/audit.ts
//
// Audit: part of the Secret Vault client. `../vault.ts` re-exports these names
// and documents the wire conventions.

import type { AppJsonValue } from "../app-request-json.ts";
import { type ApiTarget, request } from "../client.ts";
import { vaultHumanAudit, vaultHumanAuditVerified } from "./codecs-human.ts";
import { query } from "./internal.ts";

export interface VaultAuditQuery {
	action?: string;
	actorId?: string;
	/** Return rows with `seq` below this (paging cursor from `nextBefore`). */
	before?: number;
	environment?: string;
	limit?: number;
	name?: string;
}

export interface VaultAuditEvent {
	action: string;
	actor: { id: string | null; kind: string };
	/** RFC 3339. */
	at: string;
	details: AppJsonValue;
	environment?: string;
	name?: string;
	outcome: string;
	path?: string;
	requestId?: string;
	scope?: string;
	scopeId?: string;
	seq: number;
}

export interface VaultAuditVerifyReport {
	firstBadSeq?: number;
	ok: boolean;
	rows: number;
}

export function listVaultAudit(
	target: ApiTarget,
	filter: VaultAuditQuery = {}
): Promise<{ events: VaultAuditEvent[]; nextBefore: number | null }> {
	return request(
		target,
		`/api/vault/audit${query({
			before: filter.before,
			limit: filter.limit,
			name: filter.name,
			action: filter.action,
			actorId: filter.actorId,
			environment: filter.environment,
		})}`,
		{},
		vaultHumanAudit
	);
}

export function verifyVaultAudit(
	target: ApiTarget
): Promise<{ report: VaultAuditVerifyReport }> {
	return request(
		target,
		"/api/vault/audit/verify",
		{},
		vaultHumanAuditVerified
	);
}
