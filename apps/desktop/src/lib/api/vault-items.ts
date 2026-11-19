// Typed vault items (`/api/vault/items`): listings and each item's event
// timeline. Listings carry metadata only and timeline events carry field
// names, never values.

import type {
	VaultItemEvent,
	VaultItemLocation,
	VaultItemSummary,
} from "@ryuhq/core-client/vault.ts";
import { z } from "zod";
import { type ApiTarget, request } from "./client.ts";
import { vaultQueryString } from "./vault-query.ts";

export type {
	VaultItemEvent,
	VaultItemLocation,
	VaultItemSummary,
} from "@ryuhq/core-client/vault.ts";

const timestamp = z.union([z.string(), z.number()]);

const summarySchema = z
	.object({
		environment: z.string(),
		fieldCount: z.number(),
		id: z.string(),
		key: z.string(),
		kind: z.string(),
		path: z.string(),
		status: z.enum(["pending_collection", "ready"]),
		updatedAt: timestamp,
		version: z.number(),
	})
	.passthrough();

const eventSchema = z
	.object({
		actorId: z.string().optional(),
		actorKind: z.string(),
		createdAt: timestamp,
		data: z.unknown(),
		itemId: z.string(),
		name: z.string(),
		seq: z.number(),
		version: z.number(),
	})
	.passthrough();

const itemsReply = z.object({ items: z.array(summarySchema) });
const eventsReply = z.object({
	events: z.array(eventSchema),
	next: z.number(),
});

export async function listVaultItems(
	target: ApiTarget,
	location: VaultItemLocation = {}
): Promise<VaultItemSummary[]> {
	const raw = await request(
		target,
		`/api/vault/items${vaultQueryString({
			environment: location.environment,
			path: location.path,
		})}`,
		undefined,
		itemsReply
	);
	return raw.items as VaultItemSummary[];
}

/** One page of an item's timeline after `after` (no long-poll wait). */
export async function listVaultItemEvents(
	target: ApiTarget,
	key: string,
	options: VaultItemLocation & { after?: number; limit?: number } = {}
): Promise<{ events: VaultItemEvent[]; next: number }> {
	const raw = await request(
		target,
		`/api/vault/items/${encodeURIComponent(key)}/events${vaultQueryString({
			environment: options.environment,
			path: options.path,
			after: options.after,
			limit: options.limit,
		})}`,
		undefined,
		eventsReply
	);
	return { events: raw.events as VaultItemEvent[], next: raw.next };
}
