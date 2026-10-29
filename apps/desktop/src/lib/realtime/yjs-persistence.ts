// Local Yjs snapshots (IndexedDB `ryu-collaboration` / `yjs-snapshots`).
//
// Each record is the whole CRDT state of one collaborative document, so it is
// user content: it is sealed with the webview's `collaboration` content key
// (`content-seal.ts`) as `{v:1, kid, iv, ct}` plus two clear fields, `synced`
// (whether every local edit had been sent to Core when it was written) and the
// record's account. Records are keyed per account (`v1:<account>:<roomId>`) so
// a snapshot written while one account was signed in is never applied to a
// document opened by another.
//
// Legacy plaintext snapshots (a bare `ArrayBuffer` under the room id) are read
// once, written sealed (merged into a sealed record the room already has, never
// replacing it), and deleted only after the sealed write committed.
// A record sealed under another key is moved aside (`q1:` prefix, then
// `q1:<key>#<n>` when that slot already holds an earlier record), never
// deleted or overwritten. A locked key leaves everything as it is.
//
// A record sealed under a retired desktop key (one the app used earlier) opens
// and is resealed under the current key. Records set aside earlier are
// restored once they open: into an empty record, or merged into the live one
// (Yjs updates merge without loss); the aside copy is deleted only after the
// restored record read back. One that still does not open stays aside. This
// runs when a room loads, before its document can persist over the record: a
// startup sweep would race an open document that writes its whole state.

import { mergeUpdates } from "yjs";
import {
	type ContentSealer,
	ContentSealOpenError,
	contentSealer,
	isSealedBytesRecord,
	type SealedBytesRecord,
} from "../content-seal.ts";

const DATABASE_NAME = "ryu-collaboration";
const DATABASE_VERSION = 1;
const STORE_NAME = "yjs-snapshots";
const SEAL_STORE = "collaboration";
const SEAL_PURPOSE = "snapshot";
const RECORD_PREFIX = "v1:";
const QUARANTINE_PREFIX = "q1:";
/** Account segment for a session without a signed-in account. */
export const ANONYMOUS_ACCOUNT = "anonymous";

/** One stored snapshot record. */
export interface StoredYjsSnapshot extends SealedBytesRecord {
	acct: string;
	synced: boolean;
}

/** What a load returns: the opened update and whether it was fully sent. */
export interface LoadedYjsSnapshot {
	synced: boolean;
	update: Uint8Array;
}

/** The key-value store under the snapshots (IndexedDB; a map in tests). */
export interface SnapshotBackend {
	delete(key: string): Promise<void>;
	get(key: string): Promise<unknown>;
	keys(): Promise<string[]>;
	put(key: string, value: unknown): Promise<void>;
}

function openDatabase(): Promise<IDBDatabase | null> {
	if (globalThis.indexedDB === undefined) {
		return Promise.resolve(null);
	}
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
		request.onupgradeneeded = () => {
			const database = request.result;
			if (!database.objectStoreNames.contains(STORE_NAME)) {
				database.createObjectStore(STORE_NAME);
			}
		};
		request.onsuccess = () => resolve(request.result);
		request.onerror = () =>
			reject(request.error ?? new Error("IndexedDB open failed"));
	});
}

async function withStore<T>(
	mode: IDBTransactionMode,
	run: (store: IDBObjectStore) => IDBRequest<T> | null,
	fallback: T
): Promise<T> {
	const database = await openDatabase();
	if (!database) {
		return fallback;
	}
	try {
		return await new Promise<T>((resolve, reject) => {
			const transaction = database.transaction(STORE_NAME, mode);
			const request = run(transaction.objectStore(STORE_NAME));
			let result = fallback;
			if (request) {
				request.onsuccess = () => {
					result = request.result;
				};
			}
			// Resolve on commit, not on request success: a write is only durable
			// (and plaintext may only be removed after it) once the transaction
			// completed.
			transaction.oncomplete = () => resolve(result);
			const fail = () =>
				reject(transaction.error ?? new Error("Yjs snapshot storage failed"));
			transaction.onerror = fail;
			transaction.onabort = fail;
		});
	} finally {
		database.close();
	}
}

const indexedDbBackend: SnapshotBackend = {
	get: (key) =>
		withStore<unknown>("readonly", (store) => store.get(key), undefined),
	put: async (key, value) => {
		await withStore<IDBValidKey>(
			"readwrite",
			(store) => store.put(value, key),
			key
		);
	},
	delete: async (key) => {
		await withStore("readwrite", (store) => store.delete(key), undefined);
	},
	keys: async () =>
		(
			await withStore<IDBValidKey[]>(
				"readonly",
				(store) => store.getAllKeys(),
				[]
			)
		).filter((key): key is string => typeof key === "string"),
};

let backend: SnapshotBackend = indexedDbBackend;
let activeAccount: string | null = null;

/** The account new providers store their snapshots under (set at startup). */
export function currentCollaborationAccount(): string | null {
	return activeAccount;
}

/** Set by the app shell from the auth vault, before the first render. */
export function setCollaborationAccount(account: string | null): void {
	activeAccount = account;
}
let sealer: ContentSealer = contentSealer;

/** Tests: swap the storage and the sealer. Returns a restore function. */
export function setYjsSnapshotDependenciesForTests(next: {
	backend?: SnapshotBackend;
	sealer?: ContentSealer;
}): () => void {
	const previous = { backend, sealer };
	backend = next.backend ?? backend;
	sealer = next.sealer ?? sealer;
	return () => {
		backend = previous.backend;
		sealer = previous.sealer;
	};
}

function accountSegment(account: string | null | undefined): string {
	return account && account.length > 0 ? account : ANONYMOUS_ACCOUNT;
}

function recordKey(account: string, roomId: string): string {
	return `${RECORD_PREFIX}${account}:${roomId}`;
}

/** Associated-data id: the record's account and room. */
function sealId(account: string, roomId: string): string {
	return `${account}:${roomId}`;
}

function isStoredSnapshot(value: unknown): value is StoredYjsSnapshot {
	if (!isSealedBytesRecord(value)) {
		return false;
	}
	const record = value as Partial<StoredYjsSnapshot>;
	return typeof record.acct === "string" && typeof record.synced === "boolean";
}

function bytesOf(value: unknown): Uint8Array | null {
	if (value instanceof Uint8Array) {
		return value;
	}
	if (value instanceof ArrayBuffer) {
		return new Uint8Array(value);
	}
	return null;
}

/** Structural equality of two stored values (records, bytes, primitives). */
function sameStoredValue(left: unknown, right: unknown): boolean {
	if (Object.is(left, right)) {
		return true;
	}
	const leftBytes = bytesOf(left);
	const rightBytes = bytesOf(right);
	if (leftBytes || rightBytes) {
		return (
			leftBytes !== null &&
			rightBytes !== null &&
			leftBytes.length === rightBytes.length &&
			leftBytes.every((byte, index) => byte === rightBytes[index])
		);
	}
	if (
		typeof left !== "object" ||
		typeof right !== "object" ||
		left === null ||
		right === null
	) {
		return false;
	}
	const leftEntries = Object.entries(left);
	const rightRecord = right as Record<string, unknown>;
	return (
		leftEntries.length === Object.keys(right).length &&
		leftEntries.every(
			([field, value]) =>
				Object.hasOwn(rightRecord, field) &&
				sameStoredValue(value, rightRecord[field])
		)
	);
}

/**
 * Move `value` (the live record at `key`) aside. Never overwrites an earlier
 * quarantined record: a second key change would otherwise replace a snapshot
 * that may still hold edits Core never received. The first free slot of
 * `q1:<key>`, `q1:<key>#1`, `q1:<key>#2`, ... is used (or the slot already
 * holding this exact value), and the live record is deleted only after the
 * aside copy reads back.
 */
async function quarantine(key: string, value: unknown): Promise<void> {
	const first = `${QUARANTINE_PREFIX}${key}`;
	let slot = first;
	for (let attempt = 1; ; attempt += 1) {
		const existing = await backend.get(slot);
		if (existing === undefined || sameStoredValue(existing, value)) {
			break;
		}
		slot = `${first}#${attempt}`;
	}
	await backend.put(slot, value);
	if (!sameStoredValue(await backend.get(slot), value)) {
		return;
	}
	if (sameStoredValue(await backend.get(key), value)) {
		await backend.delete(key);
	}
}

async function writeSealed(
	account: string,
	roomId: string,
	update: Uint8Array,
	synced: boolean
): Promise<void> {
	const sealed = await sealer.sealBytes(
		SEAL_STORE,
		SEAL_PURPOSE,
		sealId(account, roomId),
		update
	);
	const record: StoredYjsSnapshot = { ...sealed, acct: account, synced };
	await backend.put(recordKey(account, roomId), record);
}

/**
 * Open the stored record `stored` of `roomId` under `account`. Throws
 * `ContentSealLockedError` while the key is unavailable (nothing is changed)
 * and `ContentSealOpenError` after moving a record that does not open aside.
 */
async function openStored(
	acct: string,
	roomId: string,
	stored: unknown
): Promise<LoadedYjsSnapshot> {
	return (await openStoredRecord(acct, roomId, stored)).loaded;
}

/**
 * {@link openStored}, also returning the record now stored: `stored`, or its
 * reseal under the current key when a retired key opened it.
 */
async function openStoredRecord(
	acct: string,
	roomId: string,
	stored: unknown
): Promise<{ loaded: LoadedYjsSnapshot; record: unknown }> {
	const key = recordKey(acct, roomId);
	if (!isStoredSnapshot(stored)) {
		await quarantine(key, stored);
		throw new ContentSealOpenError("A local document snapshot is malformed");
	}
	const kid = await sealer.kid(SEAL_STORE);
	const retired = await sealer.retiredKids(SEAL_STORE);
	if (stored.kid !== kid && !retired.includes(stored.kid)) {
		await quarantine(key, stored);
		throw new ContentSealOpenError(
			"A local document snapshot was sealed with another key; it was kept aside"
		);
	}
	try {
		const { value: update, stale } = await sealer.openBytesEntry(
			SEAL_STORE,
			SEAL_PURPOSE,
			sealId(acct, roomId),
			stored
		);
		const loaded = { update, synced: stored.synced };
		const record = stale
			? await resealRecord(acct, roomId, stored, update)
			: stored;
		return { loaded, record };
	} catch (error) {
		if (error instanceof ContentSealOpenError) {
			await quarantine(key, stored);
		}
		throw error;
	}
}

/**
 * Write `update` (opened from `stored` under a retired key) again under the
 * current key, unless the record changed meanwhile. Returns the record now
 * stored. A failed write keeps the old record (it still opens).
 */
async function resealRecord(
	acct: string,
	roomId: string,
	stored: StoredYjsSnapshot,
	update: Uint8Array
): Promise<unknown> {
	const key = recordKey(acct, roomId);
	try {
		const sealed = await sealer.sealBytes(
			SEAL_STORE,
			SEAL_PURPOSE,
			sealId(acct, roomId),
			update
		);
		const record: StoredYjsSnapshot = {
			...sealed,
			acct,
			synced: stored.synced,
		};
		if (!sameRecord(await backend.get(key), stored)) {
			return await backend.get(key);
		}
		await backend.put(key, record);
		return record;
	} catch {
		return await backend.get(key);
	}
}

/** The quarantine slots of record `key` (`q1:<key>`, `q1:<key>#<n>`), in order. */
function quarantineSlotsOf(keys: readonly string[], key: string): string[] {
	const first = `${QUARANTINE_PREFIX}${key}`;
	return keys
		.filter(
			(slot) =>
				slot === first ||
				(slot.startsWith(`${first}#`) &&
					QUARANTINE_INDEX.test(slot.slice(first.length)))
		)
		.sort((left, right) => slotIndex(left) - slotIndex(right));
}

const QUARANTINE_INDEX = /^#(\d+)$/;

function slotIndex(slot: string): number {
	const match = /#(\d+)$/.exec(slot);
	return match ? Number(match[1]) : 0;
}

/**
 * Restore the quarantined record in `slot` into record `key` if it opens now
 * (under the current or a retired key): stored when `key` is empty, merged
 * into the live record otherwise. The aside copy is deleted only after the
 * restored record read back; anything that does not open, or a record that
 * changed meanwhile, is left as it is. Throws `ContentSealLockedError` while
 * the key is locked (nothing changed). Returns whether it was restored.
 */
async function restoreQuarantinedRecord(
	slot: string,
	key: string
): Promise<boolean> {
	const aside = await backend.get(slot);
	if (!isStoredSnapshot(aside)) {
		return false;
	}
	const prefix = recordKey(aside.acct, "");
	if (!key.startsWith(prefix)) {
		return false;
	}
	const roomId = key.slice(prefix.length);
	let restored: Uint8Array;
	try {
		restored = (
			await sealer.openBytesEntry(
				SEAL_STORE,
				SEAL_PURPOSE,
				sealId(aside.acct, roomId),
				aside
			)
		).value;
	} catch (error) {
		if (error instanceof ContentSealOpenError) {
			return false;
		}
		throw error;
	}
	let expected = await backend.get(key);
	let update = restored;
	let synced = aside.synced;
	if (expected !== undefined) {
		try {
			const live = await openStoredRecord(aside.acct, roomId, expected);
			update = mergeUpdates([live.loaded.update, restored]);
			synced = live.loaded.synced && aside.synced;
			expected = live.record;
		} catch (error) {
			if (!(error instanceof ContentSealOpenError)) {
				throw error;
			}
			// The live record did not open and was moved aside itself.
			expected = undefined;
		}
	}
	const sealed = await sealer.sealBytes(
		SEAL_STORE,
		SEAL_PURPOSE,
		sealId(aside.acct, roomId),
		update
	);
	const current = await backend.get(key);
	const unchanged =
		expected === undefined
			? current === undefined
			: sameRecord(current, expected);
	if (!unchanged) {
		return false;
	}
	const record: StoredYjsSnapshot = { ...sealed, acct: aside.acct, synced };
	await backend.put(key, record);
	if (!sameRecord(await backend.get(key), record)) {
		return false;
	}
	if (sameStoredValue(await backend.get(slot), aside)) {
		await backend.delete(slot);
	}
	return true;
}

/** Restore every quarantined copy of record `key` that opens now. */
async function restoreRecordSlots(
	keys: readonly string[],
	key: string
): Promise<number> {
	let restored = 0;
	for (const slot of quarantineSlotsOf(keys, key)) {
		if (await restoreQuarantinedRecord(slot, key)) {
			restored += 1;
		}
	}
	return restored;
}

/**
 * Load the snapshot of `roomId` for `account`. Throws `ContentSealLockedError`
 * while the key is unavailable (nothing is changed) and `ContentSealOpenError`
 * after moving a record that does not open aside.
 */
export async function loadYjsSnapshot(
	roomId: string,
	account?: string | null
): Promise<LoadedYjsSnapshot | null> {
	const acct = accountSegment(account);
	// Records set aside under a key that opens again come back first, so the
	// caller's document holds them before it persists over the record.
	await restoreRecordSlots(await backend.keys(), recordKey(acct, roomId)).catch(
		() => 0
	);
	// A legacy plaintext snapshot is merged in first, even when a sealed record
	// exists (a downgraded build wrote it next to the record): the caller's
	// document must hold those edits before it ever persists over the record.
	const migrated = await migrateLegacySnapshot(roomId, acct);
	if (migrated) {
		return migrated.snapshot;
	}
	const stored = await backend.get(recordKey(acct, roomId));
	if (stored === undefined) {
		return null;
	}
	return openStored(acct, roomId, stored);
}

/** Whether two reads of a record are the same stored value. */
function sameRecord(left: unknown, right: unknown): boolean {
	if (left === right) {
		return true;
	}
	if (!(isSealedBytesRecord(left) && isSealedBytesRecord(right))) {
		return false;
	}
	return (
		left.kid === right.kid &&
		bytesEqual(left.iv, right.iv) &&
		bytesEqual(left.ct, right.ct)
	);
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
	if (left.length !== right.length) {
		return false;
	}
	for (let index = 0; index < left.length; index += 1) {
		if (left[index] !== right[index]) {
			return false;
		}
	}
	return true;
}

const LEGACY_MERGE_ATTEMPTS = 3;

/**
 * A legacy plaintext snapshot under the bare room id: seal it, then drop it.
 *
 * A sealed record may already exist for the room (a downgraded build wrote a
 * plaintext snapshot next to it, or a provider persisted meanwhile). It may
 * hold edits Core never received, so it is never replaced: the two updates
 * are merged (Yjs updates merge without loss) and stored as unsynced. A
 * locked key leaves both values as they are; a record that does not open is
 * moved aside and the legacy update becomes the record.
 */
async function migrateLegacySnapshot(
	roomId: string,
	account: string
): Promise<{ migrated: boolean; snapshot: LoadedYjsSnapshot } | null> {
	const legacy = await backend.get(roomId);
	if (!(legacy instanceof ArrayBuffer)) {
		return null;
	}
	const legacyUpdate = new Uint8Array(legacy);
	const key = recordKey(account, roomId);
	for (let attempt = 0; attempt < LEGACY_MERGE_ATTEMPTS; attempt += 1) {
		const existing = await backend.get(key);
		let expected: unknown;
		let update: Uint8Array = legacyUpdate;
		if (existing !== undefined) {
			try {
				const opened = await openStoredRecord(account, roomId, existing);
				update = mergeUpdates([opened.loaded.update, legacyUpdate]);
				expected = opened.record;
			} catch (error) {
				if (!(error instanceof ContentSealOpenError)) {
					throw error;
				}
				// Moved aside: the legacy update becomes the record.
			}
		}
		const sealed = await sealer.sealBytes(
			SEAL_STORE,
			SEAL_PURPOSE,
			sealId(account, roomId),
			update
		);
		// Re-checked right before the write: a record persisted meanwhile is
		// merged on the next attempt instead of being overwritten.
		const current = await backend.get(key);
		const unchanged =
			expected === undefined
				? current === undefined
				: sameRecord(current, expected);
		if (!unchanged) {
			continue;
		}
		// Whether it reached Core is unknown: keep it as unsynced until a sync
		// says otherwise, so a sign-out never clears it silently.
		const record: StoredYjsSnapshot = {
			...sealed,
			acct: account,
			synced: false,
		};
		await backend.put(key, record);
		await backend.delete(roomId);
		return { migrated: true, snapshot: { update, synced: false } };
	}
	// Another writer kept changing the record: serve both merged in memory and
	// leave the legacy value for the next run.
	const current = await backend.get(key);
	const update =
		current === undefined
			? legacyUpdate
			: mergeUpdates([
					(await openStored(account, roomId, current)).update,
					legacyUpdate,
				]);
	return { migrated: false, snapshot: { update, synced: false } };
}

/**
 * Seal every legacy plaintext snapshot under `account` (startup sweep for rooms
 * that are not opened). Idempotent and resumable: each one is deleted only
 * after its sealed copy committed. Returns how many were sealed.
 */
export async function migrateLegacyYjsSnapshots(
	account?: string | null
): Promise<number> {
	const acct = accountSegment(account);
	let sealed = 0;
	for (const key of await backend.keys()) {
		if (key.startsWith(RECORD_PREFIX) || key.startsWith(QUARANTINE_PREFIX)) {
			continue;
		}
		if ((await migrateLegacySnapshot(key, acct))?.migrated) {
			sealed += 1;
		}
	}
	return sealed;
}

/** Seal and store a snapshot. Fails closed: without a key nothing is written. */
export async function storeYjsSnapshot(
	roomId: string,
	update: Uint8Array,
	options: { account?: string | null; synced: boolean }
): Promise<void> {
	await writeSealed(
		accountSegment(options.account),
		roomId,
		update,
		options.synced
	);
}

export async function clearYjsSnapshot(
	roomId: string,
	account?: string | null
): Promise<void> {
	await backend.delete(recordKey(accountSegment(account), roomId));
	await backend.delete(roomId);
}

/**
 * Sign-out / account switch: delete `account`'s snapshots whose edits all
 * reached Core, keep the ones that did not (they stay sealed and are never
 * loaded for another account). Needs no key.
 */
export async function releaseAccountYjsSnapshots(
	account: string | null | undefined
): Promise<{ cleared: number; kept: number }> {
	const prefix = recordKey(accountSegment(account), "");
	let cleared = 0;
	let kept = 0;
	for (const key of await backend.keys()) {
		if (!key.startsWith(prefix)) {
			continue;
		}
		const stored = await backend.get(key);
		if (isStoredSnapshot(stored) && stored.synced) {
			await backend.delete(key);
			cleared += 1;
		} else {
			kept += 1;
		}
	}
	return { cleared, kept };
}
