import { getAuthTablesWithResolvedIndexes } from "@better-auth/core/db/internal";
import type { BetterAuthOptions } from "better-auth";

/**
 * One index Better Auth declares for one of its collections, in the exact form
 * its Mongo adapter passes to `createIndex`.
 */
export interface AuthDatabaseIndex {
	/** The collection the index belongs to. */
	collection: string;
	/** The `createIndex` key pattern, with the logical `id` column as `_id`. */
	keys: Record<string, 1>;
	/** The index name Better Auth chose; building it under another name is refused by Mongo. */
	name: string;
	unique: boolean;
}

/**
 * The indexes Better Auth's Mongo adapter builds for the schema these options
 * describe (its own tables plus every plugin's), resolved by Better Auth's own
 * resolver so names, key order and uniqueness cannot drift from what the
 * adapter later asks for.
 *
 * The adapter builds a collection's indexes lazily, on that collection's first
 * write in a process. A password sign-up writes the user and its credential
 * `account` row in one multi-document transaction, and an index build that
 * starts inside it conflicts with the transaction's snapshot ("Unable to write
 * to collection ... due to catalog changes"): on a database that has never
 * stored an account, the first sign-up is aborted. Building these indexes
 * before anything is served makes the adapter's own `createIndex` a no-op.
 */
export function authDatabaseIndexes(
	options: BetterAuthOptions
): AuthDatabaseIndex[] {
	const { indexesByTable } = getAuthTablesWithResolvedIndexes(options);
	const indexes: AuthDatabaseIndex[] = [];
	for (const [collection, tableIndexes] of indexesByTable) {
		for (const index of tableIndexes) {
			indexes.push({
				collection,
				keys: Object.fromEntries(
					index.columns.map((column) => [column === "id" ? "_id" : column, 1])
				),
				name: index.name,
				unique: index.unique ?? false,
			});
		}
	}
	return indexes;
}
