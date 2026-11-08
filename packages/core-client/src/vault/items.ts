// packages/core-client/src/vault/items.ts
//
// Typed credential items: part of the Secret Vault client. `../vault.ts` re-
// exports these names and documents the wire conventions.

import type { AppJsonValue } from "../app-request-json.ts";
import { type ApiTarget, request } from "../client.ts";
import { vaultDeletedReply } from "./codecs-machine.ts";
import {
	vaultItemEventsReply,
	vaultItemReply,
	vaultItemRevealReply,
	vaultItemsReply,
} from "./codecs-reply.ts";
import { itemPath, locationQuery, query } from "./internal.ts";
import type { VaultTimestamp } from "./shared.ts";

export type VaultItemFieldType =
	| "text"
	| "email"
	| "url"
	| "password"
	| "totp"
	| "note";

export type VaultItemStatus = "pending_collection" | "ready";

export interface VaultItemLocation {
	environment?: string;
	path?: string;
}

export interface VaultItemFieldInput {
	label?: string;
	name: string;
	required?: boolean;
	/** Defaults to true for `password` and `totp`, false otherwise. */
	sensitive?: boolean;
	type: VaultItemFieldType;
}

export interface VaultItemField {
	hasValue: boolean;
	label?: string;
	name: string;
	required: boolean;
	sensitive: boolean;
	type: VaultItemFieldType;
	/** Present for non-sensitive fields when the caller has `use` or `read`. */
	value?: string;
}

/** Non-sensitive metadata of a `card` item. Never the number or CVC. */
export interface VaultCardSummary {
	brand?: string;
	expired: boolean;
	expMonth?: string;
	expYear?: string;
	last4?: string;
	/** Merchant host patterns the card may be used at. */
	merchants: string[];
	/** Broker placeholders by field (`number` → `__CARD_<KEY>_NUMBER__`). */
	placeholders: Record<string, string>;
}

export interface VaultItemSummary {
	card?: VaultCardSummary;
	environment: string;
	fieldCount: number;
	id: string;
	key: string;
	kind: string;
	path: string;
	status: VaultItemStatus;
	updatedAt: VaultTimestamp;
	version: number;
}

export interface VaultItem {
	availableOperations: string[];
	card?: VaultCardSummary;
	createdAt: VaultTimestamp;
	description?: string;
	environment: string;
	fields: VaultItemField[];
	id: string;
	key: string;
	kind: string;
	path: string;
	status: VaultItemStatus;
	updatedAt: VaultTimestamp;
	version: number;
}

export interface PutVaultItemInput extends VaultItemLocation {
	description?: string;
	/** Required except for `card` items, whose schema is fixed. */
	fields?: VaultItemFieldInput[];
	kind?: string;
	/** Merchant host allowlist (`card` items only). */
	merchants?: string[];
	values?: Record<string, string>;
}

/** A guarded change: `null` clears a value or the description. */
export interface PatchVaultItemInput extends VaultItemLocation {
	description?: string | null;
	expectedId: string;
	expectedVersion: number;
	/** Replace a card's merchant host allowlist. */
	merchants?: string[];
	values?: Record<string, string | null>;
}

export interface VaultItemEvent {
	actorId?: string;
	actorKind: string;
	createdAt: VaultTimestamp;
	data: AppJsonValue;
	itemId: string;
	name: string;
	seq: number;
	version: number;
}

export function listVaultItems(
	target: ApiTarget,
	location: VaultItemLocation = {}
): Promise<{ items: VaultItemSummary[] }> {
	return request(
		target,
		`/api/vault/items${locationQuery(location)}`,
		{},
		vaultItemsReply
	);
}

/** The field schema, `hasValue`, and non-sensitive values. */
export function getVaultItem(
	target: ApiTarget,
	key: string,
	location: VaultItemLocation = {}
): Promise<{ item: VaultItem }> {
	return request(
		target,
		`${itemPath(key)}${locationQuery(location)}`,
		{},
		vaultItemReply
	);
}

/** Create an item, or confirm an identical one (Core answers 201 or 200;
 *  a different schema or value is a 409). */
export function putVaultItem(
	target: ApiTarget,
	key: string,
	input: PutVaultItemInput
): Promise<{ item: VaultItem }> {
	return request(
		target,
		itemPath(key),
		{ method: "PUT", body: input },
		vaultItemReply
	);
}

export function patchVaultItem(
	target: ApiTarget,
	key: string,
	input: PatchVaultItemInput
): Promise<{ item: VaultItem }> {
	return request(
		target,
		itemPath(key),
		{ method: "PATCH", body: input },
		vaultItemReply
	);
}

export function deleteVaultItem(
	target: ApiTarget,
	key: string,
	options: VaultItemLocation & { expectedVersion?: number } = {}
): Promise<{ deleted: boolean }> {
	return request(
		target,
		`${itemPath(key)}${query({
			environment: options.environment,
			path: options.path,
			expectedVersion: options.expectedVersion,
		})}`,
		{ method: "DELETE" },
		vaultDeletedReply
	);
}

/** Reveal one field's value (`read`; audited). */
export function revealVaultItemField(
	target: ApiTarget,
	key: string,
	field: string,
	location: VaultItemLocation = {}
): Promise<{ field: string; value: string }> {
	return request(
		target,
		itemPath(key, "/reveal"),
		{ method: "POST", body: { ...location, field } },
		vaultItemRevealReply
	);
}

/** The item's event timeline after `after`, long-polling up to `wait` seconds. */
export function listVaultItemEvents(
	target: ApiTarget,
	key: string,
	options: VaultItemLocation & {
		after?: number;
		limit?: number;
		wait?: number;
	} = {},
	signal?: AbortSignal
): Promise<{ events: VaultItemEvent[]; next: number }> {
	return request(
		target,
		`${itemPath(key, "/events")}${query({
			environment: options.environment,
			path: options.path,
			after: options.after,
			limit: options.limit,
			wait: options.wait,
		})}`,
		{ signal },
		vaultItemEventsReply
	);
}
