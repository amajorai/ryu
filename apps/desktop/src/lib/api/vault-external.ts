// External secret stores and secret syncs (`/api/vault/external/*`): sync
// targets (GitHub Actions, Vercel, AWS Secrets Manager, Google Cloud Secret
// Manager), the folders pushed to them, and folders sourced from OpenBao,
// HashiCorp Vault or Infisical. Store credentials are sent on create only;
// Core never returns them or a secret value on these routes.

import type {
	VaultExternalDestination,
	VaultExternalDestinationInput,
	VaultExternalSource,
	VaultExternalStore,
	VaultExternalStoreInput,
	VaultExternalSyncReport,
} from "@ryuhq/core-client/vault-external";
import { z } from "zod";
import { type ApiTarget, request } from "./client.ts";

export type {
	VaultExternalDestination,
	VaultExternalDestinationInput,
	VaultExternalSource,
	VaultExternalStore,
	VaultExternalStoreInput,
} from "@ryuhq/core-client/vault-external";

const BASE = "/api/vault/external";
const id = (value: string) => encodeURIComponent(value);

const storeSchema = z
	.object({
		address: z.string(),
		authMethod: z.string(),
		id: z.string(),
		kind: z.string(),
		name: z.string(),
	})
	.passthrough();

const destinationSchema = z
	.object({
		dirty: z.boolean(),
		environment: z.string(),
		failures: z.number(),
		id: z.string(),
		intervalSecs: z.number(),
		lastCount: z.number(),
		lastError: z.string().nullable(),
		lastPushAt: z.number().nullable(),
		lastStatus: z.string().nullable(),
		path: z.string(),
		remotePath: z.string(),
		storeId: z.string(),
	})
	.passthrough();

const sourceSchema = z
	.object({
		environment: z.string(),
		id: z.string(),
		lastCount: z.number(),
		lastError: z.string().nullable(),
		lastStatus: z.string().nullable(),
		lastSyncAt: z.number().nullable(),
		mode: z.enum(["live", "sync"]),
		path: z.string(),
		remotePath: z.string(),
		storeId: z.string(),
		syncIntervalSecs: z.number(),
	})
	.passthrough();

const storesSchema = z.object({ stores: z.array(storeSchema) });
const storeReply = z.object({ store: storeSchema });
const destinationsSchema = z.object({
	destinations: z.array(destinationSchema),
});
const destinationReply = z.object({ destination: destinationSchema });
const sourcesSchema = z.object({ sources: z.array(sourceSchema) });
const deletedSchema = z.object({ deleted: z.boolean() });
const testSchema = z.object({ error: z.string().optional(), ok: z.boolean() });
const pushSchema = z.object({ pushed: z.number() });
const syncSchema = z.object({
	report: z.object({
		removed: z.number(),
		unchanged: z.number(),
		written: z.number(),
	}),
});

export async function listVaultExternalStores(
	target: ApiTarget
): Promise<VaultExternalStore[]> {
	const raw = await request(target, `${BASE}/stores`, undefined, storesSchema);
	return raw.stores as unknown as VaultExternalStore[];
}

export async function createVaultExternalStore(
	target: ApiTarget,
	input: VaultExternalStoreInput
): Promise<VaultExternalStore> {
	const raw = await request(
		target,
		`${BASE}/stores`,
		{ method: "POST", body: input },
		storeReply
	);
	return raw.store as unknown as VaultExternalStore;
}

export async function deleteVaultExternalStore(
	target: ApiTarget,
	storeId: string
): Promise<boolean> {
	const raw = await request(
		target,
		`${BASE}/stores/${id(storeId)}`,
		{ method: "DELETE" },
		deletedSchema
	);
	return raw.deleted;
}

/** `ok: false` with the store's refusal (status code only) when it answers but fails. */
export function testVaultExternalStore(
	target: ApiTarget,
	storeId: string
): Promise<{ error?: string; ok: boolean }> {
	return request(
		target,
		`${BASE}/stores/${id(storeId)}/test`,
		{ method: "POST" },
		testSchema
	);
}

export async function listVaultExternalDestinations(
	target: ApiTarget
): Promise<VaultExternalDestination[]> {
	const raw = await request(
		target,
		`${BASE}/destinations`,
		undefined,
		destinationsSchema
	);
	return raw.destinations as VaultExternalDestination[];
}

export async function createVaultExternalDestination(
	target: ApiTarget,
	input: VaultExternalDestinationInput
): Promise<VaultExternalDestination> {
	const raw = await request(
		target,
		`${BASE}/destinations`,
		{ method: "POST", body: input },
		destinationReply
	);
	return raw.destination as VaultExternalDestination;
}

export async function deleteVaultExternalDestination(
	target: ApiTarget,
	destinationId: string
): Promise<boolean> {
	const raw = await request(
		target,
		`${BASE}/destinations/${id(destinationId)}`,
		{ method: "DELETE" },
		deletedSchema
	);
	return raw.deleted;
}

/** Push now; resolves to the number of keys pushed. */
export async function pushVaultExternalDestination(
	target: ApiTarget,
	destinationId: string
): Promise<number> {
	const raw = await request(
		target,
		`${BASE}/destinations/${id(destinationId)}/push`,
		{ method: "POST" },
		pushSchema
	);
	return raw.pushed;
}

export async function listVaultExternalSources(
	target: ApiTarget
): Promise<VaultExternalSource[]> {
	const raw = await request(
		target,
		`${BASE}/sources`,
		undefined,
		sourcesSchema
	);
	return raw.sources as VaultExternalSource[];
}

export async function syncVaultExternalSource(
	target: ApiTarget,
	sourceId: string
): Promise<VaultExternalSyncReport> {
	const raw = await request(
		target,
		`${BASE}/sources/${id(sourceId)}/sync`,
		{ method: "POST" },
		syncSchema
	);
	return raw.report;
}

export async function deleteVaultExternalSource(
	target: ApiTarget,
	sourceId: string
): Promise<boolean> {
	const raw = await request(
		target,
		`${BASE}/sources/${id(sourceId)}`,
		{ method: "DELETE" },
		deletedSchema
	);
	return raw.deleted;
}
