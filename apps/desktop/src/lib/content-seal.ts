// Content sealing for the desktop webview's own stores: the collaboration Yjs
// snapshots in IndexedDB and the few localStorage values that hold user content
// or PII (Prompt Studio suites, bot-feed comments, session tabs, workbench
// layout, the signed-in user's name/email/avatar).
//
// Key source, per store:
//   - Tauri desktop: the `desktop_content_key` command derives a 32-byte key
//     from the desktop app key held in the OS keychain (`HKDF`, store
//     `desktop-webview:<store>`). It is imported once per session as a
//     NON-EXTRACTABLE AES-GCM `CryptoKey`; the raw bytes are zeroed right after.
//   - Browser hosts (the web app shim answers `null`): the origin's
//     non-extractable IndexedDB device key from `browser-seal.ts`. That only
//     protects offline copies of the browser profile; the docs say so.
//
// Values: `wenc:v1:` + base64(iv || ct || tag), associated data
// `content:<store>:<purpose>:<id>`, so a value copied to another slot or record
// does not open. Binary records (Yjs) are `{v:1, kid, iv, ct}`.
//
// Key unavailable (keychain locked, command failed) is NOT decrypt failure:
// callers get {@link ContentSealLockedError}, keep what is on disk, and retry
// later. A key is never generated here. Every store keeps a key id (`kid`, a
// check value of the key) so a value sealed under another key is recognised and
// quarantined instead of being treated as corrupt or cleared.
//
// Retired keys: the desktop also hands over the keys derived from desktop keys
// it used earlier (a file key from a launch without a reachable keychain next
// to the keychain key). They only open; whatever they opened is resealed under
// the current key, and values set aside under them are restored once they open.

import {
	BROWSER_SEAL_PREFIX,
	loadBrowserDeviceKey,
	looksBrowserSealed,
} from "./browser-seal.ts";
// A namespace import: test suites that mock `tauri-ready` with only the
// helpers they need must not fail to link this module.
import * as tauriReady from "./tauri-ready.ts";

/** The webview stores that may be sealed. Mirrors the Tauri allowlist. */
export type ContentStore = "collaboration" | "local-storage";

/** The key is not reachable right now (locked keychain, no IndexedDB). */
export class ContentSealLockedError extends Error {
	constructor(message = "Encrypted local storage is locked") {
		super(message);
		this.name = "ContentSealLockedError";
	}
}

/** A sealed value did not open with this device's key for this slot. */
export class ContentSealOpenError extends Error {
	constructor(message = "A sealed local value could not be opened") {
		super(message);
		this.name = "ContentSealOpenError";
	}
}

/** A binary sealed record (IndexedDB structured clone). */
export interface SealedBytesRecord {
	ct: Uint8Array;
	iv: Uint8Array;
	kid: string;
	v: 1;
}

export interface ContentKey {
	key: CryptoKey;
	/** Key check value: hex of the first 8 bytes of a fixed AES-GCM block. */
	kid: string;
	/**
	 * Keys this store was sealed with earlier (desktop only; none in a
	 * browser). They open values, never seal them.
	 */
	retired?: readonly RetiredContentKey[];
}

/** A key that still opens what it sealed. */
export interface RetiredContentKey {
	key: CryptoKey;
	kid: string;
}

/** An opened value and whether it was sealed under a retired key. */
export interface OpenedContent<T> {
	/** Sealed under a retired key: write it again under the current key. */
	stale: boolean;
	value: T;
}

export type ContentKeySource = (store: ContentStore) => Promise<ContentKey>;

const IV_BYTES = 12;
const KID_IV = new TextEncoder().encode("ryu-kid-v1\0\0");
const KID_AAD = new TextEncoder().encode("ryu-content-kid-v1");

function toBase64(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary);
}

function fromBase64(encoded: string): Uint8Array {
	const binary = atob(encoded);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) {
		bytes[index] = binary.charCodeAt(index);
	}
	return bytes;
}

function toHex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
		""
	);
}

/** The key id of `key`: a check value that reveals nothing about the key. */
export async function contentKeyId(key: CryptoKey): Promise<string> {
	const block = await crypto.subtle.encrypt(
		{ name: "AES-GCM", iv: KID_IV, additionalData: KID_AAD },
		key,
		new Uint8Array(16)
	);
	return toHex(new Uint8Array(block).slice(0, 8));
}

/**
 * WebCrypto takes `ArrayBuffer`-backed views only. Views over another buffer
 * kind (a `SharedArrayBuffer`) are copied; ordinary ones pass as they are.
 */
function asBufferSource(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
	return bytes.buffer instanceof ArrayBuffer
		? (bytes as Uint8Array<ArrayBuffer>)
		: new Uint8Array(bytes);
}

/** Import raw key bytes as a non-extractable AES-GCM key, then zero them. */
export async function importContentKey(raw: Uint8Array): Promise<ContentKey> {
	try {
		if (raw.length !== 32) {
			throw new ContentSealLockedError("The desktop content key is malformed");
		}
		const key = await crypto.subtle.importKey(
			"raw",
			asBufferSource(raw),
			{ name: "AES-GCM" },
			false,
			["encrypt", "decrypt"]
		);
		return { key, kid: await contentKeyId(key) };
	} finally {
		raw.fill(0);
	}
}

function keyBytes(value: unknown): Uint8Array | null {
	if (!Array.isArray(value)) {
		return null;
	}
	const bytes = Uint8Array.from(value, (byte) => Number(byte));
	value.fill(0);
	return bytes;
}

/**
 * The command's answer: `{ key, retired }`, or a bare byte array from a build
 * that sent only the current key. Throws locked on anything else.
 */
export function parseDesktopContentKeys(raw: unknown): {
	key: Uint8Array;
	retired: Uint8Array[];
} {
	const bare = keyBytes(raw);
	if (bare) {
		return { key: bare, retired: [] };
	}
	if (typeof raw === "object" && raw !== null) {
		const answer = raw as { key?: unknown; retired?: unknown };
		const retired = Array.isArray(answer.retired)
			? answer.retired
					.map(keyBytes)
					.filter((bytes): bytes is Uint8Array => bytes !== null)
			: [];
		const key = keyBytes(answer.key);
		if (key) {
			return { key, retired };
		}
		for (const bytes of retired) {
			bytes.fill(0);
		}
	}
	throw new ContentSealLockedError("The desktop content key is malformed");
}

/**
 * Import the current key and the retired ones (each non-extractable, every
 * raw byte zeroed). A malformed retired key is skipped; one equal to the
 * current key is dropped.
 */
export async function importContentKeys(
	raw: Uint8Array,
	retiredRaw: readonly Uint8Array[] = []
): Promise<ContentKey> {
	try {
		const current = await importContentKey(raw);
		const retired: RetiredContentKey[] = [];
		for (const bytes of retiredRaw) {
			try {
				const imported = await importContentKey(bytes);
				if (
					imported.kid !== current.kid &&
					!retired.some((known) => known.kid === imported.kid)
				) {
					retired.push(imported);
				}
			} catch {
				// Not a usable key: it opens nothing.
			}
		}
		return { ...current, retired };
	} finally {
		for (const bytes of retiredRaw) {
			bytes.fill(0);
		}
	}
}

/**
 * The default key source: the Tauri command on the desktop, the browser
 * device key where the host answers `null` (the web app shim).
 */
export const desktopContentKeySource: ContentKeySource = async (store) => {
	let raw: unknown;
	try {
		// Queues behind the IPC bridge on a cold start instead of failing early.
		raw = await tauriReady.invokeWhenReady<unknown>("desktop_content_key", {
			store,
		});
	} catch {
		throw new ContentSealLockedError(
			"The desktop encryption key is unavailable"
		);
	}
	if (raw === null || raw === undefined) {
		try {
			const key = await loadBrowserDeviceKey();
			return { key, kid: await contentKeyId(key) };
		} catch {
			throw new ContentSealLockedError(
				"Encrypted browser storage is unavailable"
			);
		}
	}
	const { key, retired } = parseDesktopContentKeys(raw);
	return importContentKeys(key, retired);
};

/** Associated data of one sealed value. */
export function contentPurpose(
	store: ContentStore,
	purpose: string,
	id: string
): string {
	return `content:${store}:${purpose}:${id}`;
}

/** True for a `wenc:v1:` value. */
export function looksContentSealed(value: string): boolean {
	return looksBrowserSealed(value);
}

/** Seals and opens the webview's content, one cached key per store. */
export class ContentSealer {
	private readonly keys = new Map<ContentStore, Promise<ContentKey>>();
	private readonly source: ContentKeySource;

	constructor(source: ContentKeySource) {
		this.source = source;
	}

	/** The store's key; a failure is not cached, so a later call retries. */
	key(store: ContentStore): Promise<ContentKey> {
		let pending = this.keys.get(store);
		if (!pending) {
			pending = this.source(store);
			this.keys.set(store, pending);
			pending.catch(() => {
				this.keys.delete(store);
			});
		}
		return pending;
	}

	async kid(store: ContentStore): Promise<string> {
		return (await this.key(store)).kid;
	}

	/** The ids of the store's retired keys (open only). */
	async retiredKids(store: ContentStore): Promise<string[]> {
		return ((await this.key(store)).retired ?? []).map(({ kid }) => kid);
	}

	/**
	 * The keys to try, the current one first; a key whose id is `kid` (a
	 * record's) moves to the front.
	 */
	private async candidates(
		store: ContentStore,
		kid?: string
	): Promise<{ key: CryptoKey; stale: boolean }[]> {
		const current = await this.key(store);
		const all = [
			{ key: current.key, kid: current.kid, stale: false },
			...(current.retired ?? []).map((retired) => ({
				key: retired.key,
				kid: retired.kid,
				stale: true,
			})),
		];
		const preferred = all.findIndex((candidate) => candidate.kid === kid);
		if (preferred > 0) {
			all.unshift(...all.splice(preferred, 1));
		}
		return all;
	}

	/** Decrypt with the current key, then each retired key. */
	private async decrypt(
		store: ContentStore,
		purpose: string,
		id: string,
		iv: Uint8Array,
		ct: Uint8Array,
		kid?: string
	): Promise<OpenedContent<ArrayBuffer>> {
		const additionalData = new TextEncoder().encode(
			contentPurpose(store, purpose, id)
		);
		for (const candidate of await this.candidates(store, kid)) {
			try {
				const value = await crypto.subtle.decrypt(
					{ name: "AES-GCM", iv: asBufferSource(iv), additionalData },
					candidate.key,
					asBufferSource(ct)
				);
				return { value, stale: candidate.stale };
			} catch {
				// Not this key; try the next one.
			}
		}
		throw new ContentSealOpenError();
	}

	async sealText(
		store: ContentStore,
		purpose: string,
		id: string,
		plaintext: string
	): Promise<string> {
		const { key } = await this.key(store);
		const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
		const ct = await crypto.subtle.encrypt(
			{
				name: "AES-GCM",
				iv,
				additionalData: new TextEncoder().encode(
					contentPurpose(store, purpose, id)
				),
			},
			key,
			new TextEncoder().encode(plaintext)
		);
		const envelope = new Uint8Array(IV_BYTES + ct.byteLength);
		envelope.set(iv, 0);
		envelope.set(new Uint8Array(ct), IV_BYTES);
		return `${BROWSER_SEAL_PREFIX}${toBase64(envelope)}`;
	}

	/** Open a `wenc:v1:` value. Throws {@link ContentSealOpenError} or locked. */
	async openText(
		store: ContentStore,
		purpose: string,
		id: string,
		stored: string
	): Promise<string> {
		return (await this.openTextEntry(store, purpose, id, stored)).value;
	}

	/**
	 * {@link openText}, also saying whether a retired key opened it (the
	 * caller then reseals it under the current key).
	 */
	async openTextEntry(
		store: ContentStore,
		purpose: string,
		id: string,
		stored: string
	): Promise<OpenedContent<string>> {
		if (!looksContentSealed(stored)) {
			throw new ContentSealOpenError("The stored value is not sealed");
		}
		let envelope: Uint8Array;
		try {
			envelope = fromBase64(stored.slice(BROWSER_SEAL_PREFIX.length));
		} catch {
			throw new ContentSealOpenError("The sealed value is malformed");
		}
		if (envelope.length <= IV_BYTES + 16) {
			throw new ContentSealOpenError("The sealed value is malformed");
		}
		const opened = await this.decrypt(
			store,
			purpose,
			id,
			envelope.slice(0, IV_BYTES),
			envelope.slice(IV_BYTES)
		);
		return {
			stale: opened.stale,
			value: new TextDecoder().decode(opened.value),
		};
	}

	async sealBytes(
		store: ContentStore,
		purpose: string,
		id: string,
		bytes: Uint8Array
	): Promise<SealedBytesRecord> {
		const { key, kid } = await this.key(store);
		const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
		const ct = await crypto.subtle.encrypt(
			{
				name: "AES-GCM",
				iv,
				additionalData: new TextEncoder().encode(
					contentPurpose(store, purpose, id)
				),
			},
			key,
			asBufferSource(bytes)
		);
		return { v: 1, kid, iv, ct: new Uint8Array(ct) };
	}

	async openBytes(
		store: ContentStore,
		purpose: string,
		id: string,
		record: SealedBytesRecord
	): Promise<Uint8Array> {
		return (await this.openBytesEntry(store, purpose, id, record)).value;
	}

	/**
	 * {@link openBytes}, also saying whether a retired key opened it. The key
	 * named by the record's `kid` is tried first.
	 */
	async openBytesEntry(
		store: ContentStore,
		purpose: string,
		id: string,
		record: SealedBytesRecord
	): Promise<OpenedContent<Uint8Array>> {
		const opened = await this.decrypt(
			store,
			purpose,
			id,
			record.iv,
			record.ct,
			record.kid
		);
		return { stale: opened.stale, value: new Uint8Array(opened.value) };
	}
}

/** True for a structurally valid {@link SealedBytesRecord}. */
export function isSealedBytesRecord(
	value: unknown
): value is SealedBytesRecord {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const record = value as Partial<SealedBytesRecord>;
	return (
		record.v === 1 &&
		typeof record.kid === "string" &&
		record.iv instanceof Uint8Array &&
		record.iv.length === IV_BYTES &&
		record.ct instanceof Uint8Array
	);
}

/** The webview's sealer (desktop key on Tauri, device key in a browser). */
export const contentSealer = new ContentSealer(desktopContentKeySource);

// ── Sealed localStorage values ─────────────────────────────────────────────
//
// A few localStorage keys hold user content or PII. Their readers are
// synchronous, so they read an in-memory cache that `hydrate()` fills before
// the first render; writes update the cache at once and are sealed and written
// in the background. Plaintext is never written: while the key is locked a
// write waits in memory.
//
// Sealed values live under their own namespace (`ryu-sealed:<key>`), never in
// place: a build from before sealing (a stale web app tab during a deploy, a
// rollback, a downgraded desktop) reads the plain key, finds nothing, and does
// not overwrite the sealed value with an empty one it failed to parse. A
// plaintext value at the plain key (written before sealing, or by such a
// build later on) is folded into the sealed value: merged for Prompt Studio
// suites (rows by id), preferred for the other keys (the sealed value it
// replaces is kept aside). The plain key is removed only once the sealed value
// read back, and only if it still holds the plaintext that was folded in.
//
// Every background write is a compare-and-swap against the stored string it
// was based on, so it never overwrites a value another window wrote meanwhile.
// A value sealed under another key (the store's `kid` marker differs) or that
// does not open is moved aside, never deleted. A value sealed under a retired
// key opens and is resealed under the current key. Values set aside before
// this hydration are restored once they open: into an empty slot, or merged
// into the live value where the key has a merge (otherwise they stay aside).

/** Exact localStorage keys whose values are sealed. */
export const SEALED_LOCAL_KEYS: readonly string[] = [
	"ryu_session_tabs",
	"ryu_workbench_layout_v2",
	"ryu_oidc_user",
	"ryu:bot-feed-engagement:v1",
];

/** Key prefixes whose values are sealed (Prompt Studio suites per agent). */
export const SEALED_LOCAL_PREFIXES: readonly string[] = [
	"prompt-studio-tests:",
];

const PROMPT_SUITE_PREFIX = "prompt-studio-tests:";

/** Where the sealed value of a sealed key is stored. */
export const SEALED_LOCAL_NAMESPACE = "ryu-sealed:";

/** The storage slot holding the sealed value of `key`. */
export function sealedLocalSlot(key: string): string {
	return `${SEALED_LOCAL_NAMESPACE}${key}`;
}

const LOCAL_STORE: ContentStore = "local-storage";
const LOCAL_PURPOSE = "value";
/** The key id the store's values are sealed under. */
export const LOCAL_KID_MARKER_KEY = "ryu-content-seal:local-storage:kid";
/** Values that did not open (or were replaced by an older build's) are kept here. */
export const LOCAL_QUARANTINE_PREFIX = "ryu-content-seal:quarantine:";
/**
 * A non-secret marker the facade keeps in localStorage. When it disappears,
 * something cleared the storage behind the facade (the "deep clean" reset, a
 * `localStorage.clear()` in another window), so the cache and pending writes
 * are dropped instead of being served or written back.
 */
export const LOCAL_PRESENCE_KEY = "ryu-content-seal:local-storage:present";

function isSealedLogicalKey(key: string): boolean {
	return (
		SEALED_LOCAL_KEYS.includes(key) ||
		SEALED_LOCAL_PREFIXES.some((prefix) => key.startsWith(prefix))
	);
}

/**
 * Whether `key` is one of the sealed localStorage keys, or one of the slots
 * the facade keeps their sealed or quarantined values in. None of them may
 * leave the device (settings sync excludes them).
 */
export function isSealedLocalKey(key: string): boolean {
	return (
		isSealedLogicalKey(key) ||
		key.startsWith(SEALED_LOCAL_NAMESPACE) ||
		key.startsWith(LOCAL_QUARANTINE_PREFIX)
	);
}

function parseObject(raw: string): Record<string, unknown> | null {
	try {
		const parsed: unknown = JSON.parse(raw);
		return typeof parsed === "object" &&
			parsed !== null &&
			!Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

function rowId(row: unknown): string | null {
	if (typeof row !== "object" || row === null) {
		return null;
	}
	const id = (row as { id?: unknown }).id;
	return typeof id === "string" ? id : null;
}

function isEmptyField(value: unknown): boolean {
	return (
		value === undefined ||
		value === null ||
		value === "" ||
		(Array.isArray(value) && value.length === 0)
	);
}

/**
 * Merge two Prompt Studio suites without losing a row: `preferred`'s fields
 * win where set, rows are the union by id (`preferred`'s copy first). Returns
 * null when either value is not a suite object.
 */
export function mergePromptSuites(
	other: string,
	preferred: string
): string | null {
	const base = parseObject(other);
	const top = parseObject(preferred);
	if (!(base && top)) {
		return null;
	}
	const merged: Record<string, unknown> = { ...base };
	for (const [field, value] of Object.entries(top)) {
		if (!(isEmptyField(value) && field in merged)) {
			merged[field] = value;
		}
	}
	const topRows = Array.isArray(top.rows) ? top.rows : [];
	const baseRows = Array.isArray(base.rows) ? base.rows : [];
	const seen = new Set(topRows.map(rowId).filter((id) => id !== null));
	merged.rows = [
		...topRows,
		...baseRows.filter((row) => {
			const id = rowId(row);
			return id === null || !seen.has(id);
		}),
	];
	return JSON.stringify(merged);
}

/** Merge two values of `key`, or null when the key has no merge (prefer one). */
function mergeLocalValues(
	key: string,
	other: string,
	preferred: string
): string | null {
	if (key.startsWith(PROMPT_SUITE_PREFIX)) {
		return mergePromptSuites(other, preferred);
	}
	return null;
}

const EMPTY_STORAGE: Storage = {
	length: 0,
	clear: () => undefined,
	getItem: () => null,
	key: () => null,
	removeItem: () => undefined,
	setItem: () => undefined,
};

/**
 * Whether this host has any key store to seal with: the Tauri desktop (its
 * keychain-held key) or a browser with IndexedDB (its device key). A host with
 * neither (headless unit-test DOMs) has nothing to seal with, so the facade
 * passes every key straight through, exactly as before sealing existed. Every
 * shipped host (desktop webview, web app, extension) has one, and there a
 * missing key is "locked", never plaintext.
 */
export function contentSealingSupported(): boolean {
	return (
		"__TAURI_INTERNALS__" in globalThis || globalThis.indexedDB !== undefined
	);
}

function browserLocalStorage(): Storage {
	try {
		return globalThis.localStorage ?? EMPTY_STORAGE;
	} catch {
		return EMPTY_STORAGE;
	}
}

/** A value waiting to be sealed and written. */
interface PendingValue {
	/** The sealed slot's stored string this value was based on (null: none). */
	base: string | null;
	/** Plaintext at the plain key folded into this value (removed after). */
	legacy: string | null;
	/**
	 * `local`: written through this facade (a user change, always written).
	 * `legacy`: only reseals plaintext found on disk; dropped in favour of a
	 * value another window wrote, since the plaintext stays on disk until a
	 * sealed value holding it read back.
	 * `reseal`: a value opened under a retired key, written again under the
	 * current key; dropped like `legacy`.
	 * `restore`: a set-aside value restored (or merged in); dropped like
	 * `legacy`, its quarantine copy then stays where it is.
	 */
	origin: "legacy" | "local" | "reseal" | "restore";
	/**
	 * Quarantine copies (slot, stored string) this value holds; each is
	 * removed after the value read back, if it still holds that string.
	 */
	restored?: readonly (readonly [string, string])[];
	value: string;
}

/** The store's current key id and its retired ones. */
interface LocalKids {
	current: string;
	retired: readonly string[];
}

const QUARANTINE_INDEX = /^(.*)#(\d+)$/;

/**
 * The sealed keys a quarantine slot may belong to (`<key>` or `<key>#<n>`;
 * a key may itself end in `#<n>`, so both readings are offered and the
 * associated data decides). The `#superseded` slot is never offered: it holds
 * a value an older build's newer plaintext replaced on purpose.
 */
function quarantineSlotKeys(slot: string): string[] {
	if (!slot.startsWith(LOCAL_QUARANTINE_PREFIX)) {
		return [];
	}
	const rest = slot.slice(LOCAL_QUARANTINE_PREFIX.length);
	if (rest.endsWith("#superseded")) {
		return [];
	}
	const numbered = QUARANTINE_INDEX.exec(rest)?.[1];
	return [...new Set([numbered ?? rest, rest])].filter(isSealedLogicalKey);
}

function quarantineSlotIndex(slot: string): number {
	return Number(QUARANTINE_INDEX.exec(slot)?.[2] ?? 0);
}

/**
 * A `Storage` facade: sealed keys go through the cache, every other key is
 * passed straight to the underlying storage.
 */
export class SealedLocalStorage implements Storage {
	private readonly cache = new Map<string, string>();
	/** Values waiting to be sealed and written (newest per key). */
	private readonly pending = new Map<string, PendingValue>();
	/** The sealed slot's stored string the cached value came from. */
	private readonly source = new Map<string, string | null>();
	/** Plain-key plaintext already folded into this facade's view. */
	private readonly folded = new Map<string, string>();
	/** The sealed value last written from folded plaintext alone. */
	private readonly lastFoldWrite = new Map<string, string>();
	/** Sealed on disk but not opened yet (the key was locked at hydration). */
	private readonly unread = new Set<string>();
	private readonly quarantined = new Set<string>();
	/** Quarantine slots found at hydration, not restored or settled yet. */
	private restoreSlots: string[] = [];
	private flushing: Promise<void> | null = null;
	private flushAgain = false;
	private hydration: Promise<void> | null = null;
	/** Whether {@link LOCAL_PRESENCE_KEY} was written by this facade. */
	private armed = false;
	private readonly base: () => Storage;
	private readonly sealer: ContentSealer;
	private readonly supported: () => boolean;

	constructor(
		sealer: ContentSealer,
		base: () => Storage = browserLocalStorage,
		supported: () => boolean = () => true
	) {
		this.sealer = sealer;
		this.base = base;
		this.supported = supported;
	}

	private sealed(key: string): boolean {
		return isSealedLogicalKey(key) && this.supported();
	}

	get length(): number {
		return this.base().length;
	}

	key(index: number): string | null {
		return this.base().key(index);
	}

	clear(): void {
		this.dropMemory();
		this.base().clear();
	}

	private dropMemory(): void {
		this.cache.clear();
		this.pending.clear();
		this.source.clear();
		this.folded.clear();
		this.lastFoldWrite.clear();
		this.unread.clear();
		this.armed = false;
	}

	/**
	 * Drop the cache when the storage was cleared behind the facade, then make
	 * sure the presence marker is there for the next check.
	 */
	private followExternalClear(): void {
		const storage = this.base();
		try {
			if (this.armed && storage.getItem(LOCAL_PRESENCE_KEY) === null) {
				this.dropMemory();
			}
			if (!this.armed) {
				storage.setItem(LOCAL_PRESENCE_KEY, "1");
				this.armed = storage.getItem(LOCAL_PRESENCE_KEY) !== null;
			}
		} catch {
			// Storage unavailable or full: nothing to compare against.
		}
	}

	/** Another window cleared the whole storage (`storage` event, key null). */
	applyExternalClear(): void {
		this.followExternalClear();
	}

	getItem(key: string): string | null {
		if (!this.sealed(key)) {
			return this.base().getItem(key);
		}
		this.followExternalClear();
		const cached = this.cache.get(key);
		if (cached !== undefined) {
			return cached;
		}
		// Plaintext not folded in yet (a reader that ran before hydration, or a
		// value an older build wrote): readable as-is; hydration seals it.
		const raw = this.base().getItem(key);
		return raw !== null && !looksContentSealed(raw) ? raw : null;
	}

	setItem(key: string, value: string): void {
		if (!this.sealed(key)) {
			this.base().setItem(key, value);
			return;
		}
		this.followExternalClear();
		const previous = this.pending.get(key);
		this.cache.set(key, value);
		this.pending.set(key, {
			base: previous ? previous.base : (this.source.get(key) ?? null),
			legacy: previous ? previous.legacy : (this.folded.get(key) ?? null),
			origin: "local",
			value,
		});
		void this.flush();
	}

	removeItem(key: string): void {
		if (!this.sealed(key)) {
			this.base().removeItem(key);
			return;
		}
		this.followExternalClear();
		this.cache.delete(key);
		this.pending.delete(key);
		this.source.delete(key);
		this.folded.delete(key);
		this.unread.delete(key);
		const storage = this.base();
		storage.removeItem(sealedLocalSlot(key));
		storage.removeItem(key);
	}

	/** Keys whose stored value was moved aside. */
	quarantinedKeys(): string[] {
		return [...this.quarantined];
	}

	/** Whether some stored values are still unread because the key is locked. */
	isLocked(): boolean {
		return this.unread.size > 0;
	}

	/** Fill the cache from storage (once; later calls return the same promise). */
	hydrate(): Promise<void> {
		if (!this.supported()) {
			return Promise.resolve();
		}
		this.followExternalClear();
		this.hydration ??= this.load();
		return this.hydration;
	}

	/** Every sealed key with a sealed or plaintext value on disk. */
	private sealedKeysOnDisk(): string[] {
		const storage = this.base();
		const keys = new Set<string>();
		for (let index = 0; index < storage.length; index += 1) {
			const key = storage.key(index);
			if (key === null) {
				continue;
			}
			const logical = key.startsWith(SEALED_LOCAL_NAMESPACE)
				? key.slice(SEALED_LOCAL_NAMESPACE.length)
				: key;
			if (isSealedLogicalKey(logical)) {
				keys.add(logical);
			}
		}
		return [...keys];
	}

	private async currentKid(): Promise<string | null> {
		return (await this.kids())?.current ?? null;
	}

	/** The current and retired key ids; null while the key is locked. */
	private async kids(): Promise<LocalKids | null> {
		try {
			return {
				current: await this.sealer.kid(LOCAL_STORE),
				retired: await this.sealer.retiredKids(LOCAL_STORE),
			};
		} catch (error) {
			if (error instanceof ContentSealLockedError) {
				return null;
			}
			throw error;
		}
	}

	/**
	 * Keep `stored` (a value of `key`) under a quarantine slot that does not
	 * overwrite an earlier one; `removeFrom` is then removed if it still holds
	 * it. A `superseded` value (still sealed and readable, replaced by an older
	 * build's newer plaintext) takes one fixed slot per key instead, so a stale
	 * tab writing on every change does not fill the storage. Returns whether
	 * the copy read back.
	 */
	private moveAside(
		key: string,
		stored: string,
		removeFrom: string | null,
		superseded = false
	): boolean {
		const storage = this.base();
		const first = `${LOCAL_QUARANTINE_PREFIX}${key}`;
		let slot = superseded ? `${first}#superseded` : first;
		for (
			let attempt = 1;
			!superseded &&
			storage.getItem(slot) !== null &&
			storage.getItem(slot) !== stored;
			attempt += 1
		) {
			slot = `${first}#${attempt}`;
		}
		let kept = false;
		try {
			storage.setItem(slot, stored);
			kept = storage.getItem(slot) === stored;
			if (
				kept &&
				removeFrom !== null &&
				storage.getItem(removeFrom) === stored
			) {
				storage.removeItem(removeFrom);
			}
		} catch {
			// Could not move it: leave it where it is.
		}
		this.quarantined.add(key);
		return kept;
	}

	/** A slot value that does not open: aside, out of the cache. */
	private quarantine(key: string, stored: string): void {
		this.moveAside(key, stored, sealedLocalSlot(key));
		this.cache.delete(key);
		this.source.delete(key);
	}

	/**
	 * Open one sealed value into the cache; `false` while the key is locked. A
	 * value sealed under a retired key (the marker names one) opens and is
	 * queued to be resealed under the current key.
	 */
	private async openInto(key: string, kids: LocalKids): Promise<boolean> {
		const storage = this.base();
		const stored = storage.getItem(sealedLocalSlot(key));
		if (stored === null) {
			return true;
		}
		const marker = storage.getItem(LOCAL_KID_MARKER_KEY);
		if (
			marker !== null &&
			marker !== kids.current &&
			!kids.retired.includes(marker)
		) {
			this.quarantine(key, stored);
			return true;
		}
		try {
			const { value, stale } = await this.sealer.openTextEntry(
				LOCAL_STORE,
				LOCAL_PURPOSE,
				key,
				stored
			);
			const pending = this.pending.get(key);
			if (pending?.origin === "local") {
				// Written while this value was still unread (key locked at start):
				// keep the stored value aside instead of losing it to the new one.
				this.moveAside(key, stored, null);
				pending.base = stored;
			} else {
				this.pending.delete(key);
				this.cache.set(key, value);
				if (stale) {
					this.pending.set(key, {
						base: stored,
						legacy: null,
						origin: "reseal",
						value,
					});
				}
			}
			this.source.set(key, stored);
			return true;
		} catch (error) {
			if (error instanceof ContentSealLockedError) {
				return false;
			}
			this.quarantine(key, stored);
			return true;
		}
	}

	/**
	 * A value sealed in place under the plain key (an earlier sealing build):
	 * move it to its slot, or aside when the slot already holds one.
	 */
	private relocateInPlace(key: string, raw: string): void {
		const storage = this.base();
		const slot = sealedLocalSlot(key);
		try {
			if (storage.getItem(slot) === null) {
				storage.setItem(slot, raw);
				if (storage.getItem(slot) === raw) {
					storage.removeItem(key);
				}
				return;
			}
		} catch {
			return;
		}
		this.moveAside(key, raw, key);
	}

	/**
	 * Fold plaintext found at the plain key into this facade's value of `key`.
	 * Nothing is removed here: the plaintext stays until a sealed value holding
	 * it read back. Returns false while the sealed value cannot be read yet.
	 */
	private foldLegacy(key: string, raw: string): boolean {
		if (this.folded.get(key) === raw) {
			return true;
		}
		const slot = this.base().getItem(sealedLocalSlot(key));
		const local = this.pending.get(key);
		let value = raw;
		let base: string | null = slot;
		if (local?.origin === "local") {
			// This window's unsaved change is kept where the key has a merge.
			value = mergeLocalValues(key, raw, local.value) ?? raw;
			base = local.base;
		} else if (slot !== null) {
			if (this.unread.has(key) || this.source.get(key) !== slot) {
				return false;
			}
			const current = this.cache.get(key);
			if (current !== undefined) {
				const merged = mergeLocalValues(key, current, raw);
				if (merged === null && this.lastFoldWrite.get(key) !== slot) {
					// No merge for this key: the newer plaintext wins, the sealed
					// value it replaces is kept aside (still sealed), unless it
					// only held that build's previous plaintext.
					this.moveAside(key, slot, null, true);
				}
				value = merged ?? raw;
			}
		}
		this.folded.set(key, raw);
		this.cache.set(key, value);
		this.pending.set(key, {
			base,
			legacy: raw,
			origin: local?.origin === "local" ? "local" : "legacy",
			value,
		});
		return true;
	}

	private async load(): Promise<void> {
		const storage = this.base();
		// Only values set aside before this hydration are restored: one moved
		// aside now did not open (or was replaced by a local write) just now.
		this.restoreSlots = this.quarantineSlotsOnDisk();
		const kids = await this.kids();
		for (const key of this.sealedKeysOnDisk()) {
			const plain = storage.getItem(key);
			if (plain !== null && looksContentSealed(plain)) {
				this.relocateInPlace(key, plain);
			}
			if (storage.getItem(sealedLocalSlot(key)) === null) {
				this.source.set(key, null);
			} else if (kids === null || !(await this.openInto(key, kids))) {
				this.unread.add(key);
			}
			this.foldPlainKey(key);
		}
		await this.flush();
	}

	/** Quarantine slots that may be restored, in slot order per key. */
	private quarantineSlotsOnDisk(): string[] {
		const storage = this.base();
		const slots: string[] = [];
		for (let index = 0; index < storage.length; index += 1) {
			const slot = storage.key(index);
			if (slot !== null && quarantineSlotKeys(slot).length > 0) {
				slots.push(slot);
			}
		}
		return slots.sort(
			(left, right) => quarantineSlotIndex(left) - quarantineSlotIndex(right)
		);
	}

	/**
	 * Restore the values set aside before this hydration that open now (under
	 * the current or a retired key). Nothing is removed here: a quarantine copy
	 * goes only after the value holding it was written and read back. Stops
	 * (to retry on the next flush) while the key is locked.
	 */
	private async restoreQuarantined(): Promise<void> {
		const remaining: string[] = [];
		for (const [index, slot] of this.restoreSlots.entries()) {
			const outcome = await this.restoreOne(slot);
			if (outcome === "locked") {
				remaining.push(...this.restoreSlots.slice(index));
				break;
			}
			if (outcome === "later") {
				remaining.push(slot);
			}
		}
		this.restoreSlots = remaining;
	}

	private async restoreOne(slot: string): Promise<"done" | "later" | "locked"> {
		const stored = this.base().getItem(slot);
		if (stored === null || !looksContentSealed(stored)) {
			return "done";
		}
		for (const key of quarantineSlotKeys(slot)) {
			if (!this.sealed(key)) {
				continue;
			}
			let value: string;
			try {
				({ value } = await this.sealer.openTextEntry(
					LOCAL_STORE,
					LOCAL_PURPOSE,
					key,
					stored
				));
			} catch (error) {
				if (error instanceof ContentSealLockedError) {
					return "locked";
				}
				continue; // Not this key's value, or still not openable.
			}
			if (this.unread.has(key)) {
				return "later"; // The live value is not read yet.
			}
			this.adoptRestored(key, slot, stored, value);
			return "done";
		}
		return "done"; // Does not open: it stays where it is.
	}

	/** Put a restored value in the empty slot, or merge it into the live one. */
	private adoptRestored(
		key: string,
		slot: string,
		stored: string,
		value: string
	): void {
		const pending = this.pending.get(key);
		const live = this.cache.get(key);
		const restored = [...(pending?.restored ?? []), [slot, stored] as const];
		if (live === undefined) {
			if (this.base().getItem(sealedLocalSlot(key)) !== null) {
				return; // A live value this facade did not open: leave both.
			}
			this.cache.set(key, value);
			this.pending.set(key, {
				base: null,
				legacy: null,
				origin: "restore",
				restored,
				value,
			});
			return;
		}
		const merged = mergeLocalValues(key, value, live);
		if (merged === null) {
			return; // No merge for this key: the live value stays, the copy too.
		}
		this.cache.set(key, merged);
		this.pending.set(
			key,
			pending
				? { ...pending, restored, value: merged }
				: {
						base: this.source.get(key) ?? null,
						legacy: null,
						origin: "restore",
						restored,
						value: merged,
					}
		);
	}

	/** Fold the plain key's plaintext, if any, into `key`'s value. */
	private foldPlainKey(key: string): void {
		const plain = this.base().getItem(key);
		if (plain !== null && !looksContentSealed(plain)) {
			this.foldLegacy(key, plain);
		}
	}

	/**
	 * Seal and write every pending value. While the key is locked nothing is
	 * written (and nothing is lost: the values stay pending in memory).
	 */
	flush(): Promise<void> {
		if (this.flushing) {
			this.flushAgain = true;
			return this.flushing;
		}
		this.flushing = (async () => {
			try {
				do {
					this.flushAgain = false;
					await this.flushOnce();
				} while (this.flushAgain);
			} finally {
				this.flushing = null;
			}
		})();
		return this.flushing;
	}

	private async flushOnce(): Promise<void> {
		const kids = await this.kids();
		if (kids === null) {
			return;
		}
		const kid = kids.current;
		for (const key of [...this.unread]) {
			if (await this.openInto(key, kids)) {
				this.unread.delete(key);
				this.foldPlainKey(key);
			}
		}
		if (this.restoreSlots.length > 0) {
			await this.restoreQuarantined();
		}
		if (this.pending.size === 0) {
			return;
		}
		const storage = this.base();
		const marker = storage.getItem(LOCAL_KID_MARKER_KEY);
		if (marker !== kid) {
			// Only set (or move) the marker once nothing sealed under an unknown
			// key is left in place: those values were quarantined above. Values
			// under a retired key still open (and are being resealed).
			if (
				marker !== null &&
				!kids.retired.includes(marker) &&
				this.sealedKeysOnDisk().some((key) =>
					looksContentSealed(storage.getItem(sealedLocalSlot(key)) ?? "")
				)
			) {
				return;
			}
			try {
				storage.setItem(LOCAL_KID_MARKER_KEY, kid);
			} catch {
				return;
			}
		}
		for (const [key, entry] of [...this.pending]) {
			if (this.unread.has(key)) {
				continue; // Never write over a value that has not been read.
			}
			await this.writePending(key, entry);
		}
	}

	/** Seal and compare-and-swap one pending value into its slot. */
	private async writePending(key: string, entry: PendingValue): Promise<void> {
		const storage = this.base();
		const slot = sealedLocalSlot(key);
		let sealed: string;
		try {
			sealed = await this.sealText(key, entry.value);
		} catch {
			return;
		}
		if (this.pending.get(key) !== entry) {
			// Changed while sealing: the newer value is written next round.
			this.flushAgain = true;
			return;
		}
		const current = storage.getItem(slot);
		if (current !== entry.base) {
			await this.rebase(key, entry, current);
			this.flushAgain = true;
			return;
		}
		try {
			storage.setItem(slot, sealed);
		} catch {
			return;
		}
		if (storage.getItem(slot) !== sealed) {
			return;
		}
		this.pending.delete(key);
		this.source.set(key, sealed);
		if (entry.origin === "legacy") {
			this.lastFoldWrite.set(key, sealed);
		}
		if (entry.legacy !== null && storage.getItem(key) === entry.legacy) {
			storage.removeItem(key);
		}
		for (const [aside, held] of entry.restored ?? []) {
			if (storage.getItem(aside) === held) {
				storage.removeItem(aside);
			}
		}
	}

	/**
	 * Another window wrote `key`'s slot after `entry` was based on it. A
	 * reseal of plaintext is dropped for that value (the plaintext is still on
	 * disk and is folded in again); so are a reseal of a retired-key value and
	 * a restore (its quarantine copy stays and is restored on a later run). A local change is kept and rebased: merged
	 * into the other value where the key has a merge, otherwise it is still
	 * written (the later write wins, as with plain localStorage).
	 */
	private async rebase(
		key: string,
		entry: PendingValue,
		current: string | null
	): Promise<void> {
		let theirs: string | null = null;
		if (current !== null) {
			try {
				theirs = await this.sealer.openText(
					LOCAL_STORE,
					LOCAL_PURPOSE,
					key,
					current
				);
			} catch (error) {
				if (error instanceof ContentSealLockedError) {
					return;
				}
				// Does not open: kept aside, the local value takes the slot.
				this.moveAside(key, current, null);
			}
		}
		if (this.pending.get(key) !== entry) {
			return;
		}
		this.source.set(key, current);
		if (entry.origin !== "local") {
			this.pending.delete(key);
			if (theirs === null) {
				this.cache.delete(key);
			} else {
				this.cache.set(key, theirs);
			}
			this.folded.delete(key);
			this.foldPlainKey(key);
			return;
		}
		const value =
			theirs === null
				? entry.value
				: (mergeLocalValues(key, theirs, entry.value) ?? entry.value);
		this.cache.set(key, value);
		this.pending.set(key, { ...entry, base: current, value });
	}

	private sealText(key: string, value: string): Promise<string> {
		return this.sealer.sealText(LOCAL_STORE, LOCAL_PURPOSE, key, value);
	}

	/**
	 * Another window changed a storage key: a sealed slot (open the new value
	 * into the cache) or a plain sealed key (an older build wrote plaintext:
	 * fold it in).
	 */
	async applyExternalChange(
		storageKey: string,
		stored: string | null
	): Promise<void> {
		if (!storageKey.startsWith(SEALED_LOCAL_NAMESPACE)) {
			if (
				this.sealed(storageKey) &&
				stored !== null &&
				!looksContentSealed(stored) &&
				this.foldLegacy(storageKey, stored)
			) {
				await this.flush();
			}
			return;
		}
		const key = storageKey.slice(SEALED_LOCAL_NAMESPACE.length);
		if (!this.sealed(key) || this.pending.get(key)?.origin === "local") {
			// A local change is written next and rebased onto this value then.
			return;
		}
		if (stored === null) {
			this.pending.delete(key);
			this.cache.delete(key);
			this.source.set(key, null);
			return;
		}
		const kid = await this.currentKid();
		if (kid === null) {
			this.unread.add(key);
			return;
		}
		try {
			const value = await this.sealer.openText(
				LOCAL_STORE,
				LOCAL_PURPOSE,
				key,
				stored
			);
			if (this.pending.get(key)?.origin === "local") {
				return;
			}
			// A pending reseal of plaintext is superseded: the plaintext is still
			// on disk and is folded into this value instead.
			this.pending.delete(key);
			this.cache.set(key, value);
			this.source.set(key, stored);
			this.folded.delete(key);
			this.foldPlainKey(key);
			await this.flush();
		} catch {
			// Leave the cached value; the next hydration decides.
		}
	}
}

/** The desktop's sealed localStorage facade. */
export const sealedLocalStorage = new SealedLocalStorage(
	contentSealer,
	browserLocalStorage,
	contentSealingSupported
);

/** Waits between unlock retries at startup (about three seconds in all). */
export const SEALED_LOCAL_UNLOCK_RETRY_MS: readonly number[] = [
	100, 200, 400, 800, 1600,
];

/**
 * While the content key is still locked after hydration, wait and retry opening
 * the unread values, so the first render sees the stored tabs, layout and
 * comments instead of defaults it would write over them. Bounded: a key that
 * stays locked leaves those values unread and untouched on disk.
 */
export async function retrySealedLocalUnlock(
	store: Pick<SealedLocalStorage, "flush" | "isLocked">,
	delaysMs: readonly number[] = SEALED_LOCAL_UNLOCK_RETRY_MS,
	wait: (ms: number) => Promise<void> = (ms) =>
		new Promise((resolve) => setTimeout(resolve, ms))
): Promise<void> {
	for (const delay of delaysMs) {
		if (!store.isLocked()) {
			return;
		}
		await wait(delay);
		await store.flush();
	}
}

/** Hydrate before the first render and follow other windows' writes. */
export function hydrateSealedLocalStorage(): Promise<void> {
	globalThis.addEventListener?.("storage", (event: StorageEvent) => {
		if (event.key === null) {
			sealedLocalStorage.applyExternalClear();
			return;
		}
		void sealedLocalStorage.applyExternalChange(event.key, event.newValue);
	});
	return sealedLocalStorage
		.hydrate()
		.then(() => retrySealedLocalUnlock(sealedLocalStorage))
		.catch(() => undefined);
}
