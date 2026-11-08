// packages/core-client/src/vault/change-requests.ts
//
// Change requests: part of the Secret Vault client. `../vault.ts` re-exports
// these names and documents the wire conventions.

import { type ApiTarget, request } from "../client.ts";
import { vaultHumanChanges, vaultHumanDecidedChange } from "./codecs-human.ts";
import { query } from "./internal.ts";
import type { VaultChangeRequest, VaultChangeStatus } from "./values.ts";

export type VaultChangeDecision = "approve" | "reject" | "cancel";

export function listVaultChangeRequests(
	target: ApiTarget,
	status?: VaultChangeStatus
): Promise<{ changeRequests: VaultChangeRequest[] }> {
	return request(
		target,
		`/api/vault/change-requests${query({ status })}`,
		{},
		vaultHumanChanges
	);
}

export function decideVaultChangeRequest(
	target: ApiTarget,
	id: string,
	decision: VaultChangeDecision,
	reason?: string
): Promise<{ changeRequest: VaultChangeRequest; ok: boolean }> {
	return request(
		target,
		`/api/vault/change-requests/${encodeURIComponent(id)}/${decision}`,
		{ method: "POST", body: reason === undefined ? {} : { reason } },
		vaultHumanDecidedChange
	);
}
