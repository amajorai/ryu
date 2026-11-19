// packages/core-client/src/vault/rekey.ts
//
// Rekey of the Shamir key shares: part of the Secret Vault client.
// `../vault.ts` re-exports these names. Every route needs `admin` on
// `sys/rekey`. Current shares authorize the rekey one at a time; the new
// shares are returned exactly once, by the update that completes it.

import { z } from "zod";
import { type ApiTarget, request } from "../client.ts";
import {
	vaultMachineCodec,
	vaultMachineDate,
	vaultMachineNumber,
} from "./codecs-machine.ts";
import type { VaultTimestamp } from "./shared.ts";

export interface VaultRekeyStatus {
	newShares: number;
	newThreshold: number;
	/** Identifies the rekey in progress; every update must send it. */
	nonce?: string | null;
	progress: number;
	/** Current shares needed to authorize the rekey. */
	required: number;
	started: boolean;
	startedAt?: VaultTimestamp | null;
}

export interface VaultRekeyUpdate {
	complete: boolean;
	/** The new key shares: only on the update that completes the rekey. */
	shares?: string[];
	status: VaultRekeyStatus;
}

const rekeyStatus = vaultMachineCodec(
	z.object({
		started: z.boolean(),
		nonce: z.string().nullish(),
		required: vaultMachineNumber,
		progress: vaultMachineNumber,
		newShares: vaultMachineNumber,
		newThreshold: vaultMachineNumber,
		startedAt: vaultMachineDate.nullish(),
	})
);

const rekeyStatusResponse = vaultMachineCodec(z.object({ rekey: rekeyStatus }));

const rekeyUpdateResponse = vaultMachineCodec(
	z.object({
		complete: z.boolean(),
		status: rekeyStatus,
		shares: z.array(z.string()).optional(),
	})
);

export function getVaultRekey(
	target: ApiTarget
): Promise<{ rekey: VaultRekeyStatus }> {
	return request(target, "/api/vault/sys/rekey", {}, rekeyStatusResponse);
}

/** Start a rekey to `shares` new shares, `threshold` of them to unseal. */
export function initVaultRekey(
	target: ApiTarget,
	input: { shares?: number; threshold?: number } = {}
): Promise<{ rekey: VaultRekeyStatus }> {
	return request(
		target,
		"/api/vault/sys/rekey/init",
		{ method: "POST", body: input },
		rekeyStatusResponse
	);
}

/** Submit one current key share for the rekey `nonce` names. */
export function updateVaultRekey(
	target: ApiTarget,
	input: { nonce: string; share: string }
): Promise<VaultRekeyUpdate> {
	return request(
		target,
		"/api/vault/sys/rekey/update",
		{ method: "POST", body: input },
		rekeyUpdateResponse
	);
}

export function cancelVaultRekey(
	target: ApiTarget
): Promise<{ rekey: VaultRekeyStatus }> {
	return request(
		target,
		"/api/vault/sys/rekey/cancel",
		{ method: "POST", body: {} },
		rekeyStatusResponse
	);
}
