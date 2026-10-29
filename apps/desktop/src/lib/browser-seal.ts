// Browser-context sealing for credentials the web hosts must keep across reloads
// (the webapp's auth vault, node tokens and license key; the extension's account
// vault and node tokens). The Tauri desktop never uses this for credentials: it
// seals through the native `desktop_secret_*` slots with a key held in the OS
// keychain. `content-seal.ts` reuses the device key in browser hosts for their
// content stores, under its own `content:` purposes.
//
// How it works: one AES-256-GCM `CryptoKey` per browser origin, generated with
// `extractable: false` and stored as a structured-clone `CryptoKey` in IndexedDB.
// Script can ask the browser to encrypt or decrypt with it but can never read the
// key bytes, and the IndexedDB record is not the key material in a usable form
// outside this browser profile. Every value carries a purpose string as AES-GCM
// associated data, so a ciphertext copied into another slot does not open.
//
// What it protects against: a copy of the profile's localStorage /
// `chrome.storage` LevelDB files (backups, disk forensics, a synced or stolen
// profile folder read without the browser) no longer yields bearer tokens.
// What it does NOT protect against: script running in the same origin (an XSS,
// a malicious extension page) can call decrypt like we do, and a browser that
// exports the whole profile including IndexedDB keeps both halves together. It is
// not OS-keychain custody; the docs say so.
//
// Envelope: `wenc:v1:` + base64(iv(12) || ciphertext || tag(16)).

/** Prefix of a browser-sealed value. Distinct from the native `enc:v1:`. */
export const BROWSER_SEAL_PREFIX = "wenc:v1:";

const DATABASE = "ryu-browser-seal-v1";
const STORE = "keys";
const DEVICE_KEY = "device-key";
const IV_BYTES = 12;

/** No IndexedDB / WebCrypto here (or the key store is broken): nothing is sealed. */
export class BrowserSealUnavailableError extends Error {
	constructor(message = "Encrypted browser storage is unavailable") {
		super(message);
		this.name = "BrowserSealUnavailableError";
	}
}

/** True for a value written by {@link BrowserSealer.seal}. */
export function looksBrowserSealed(value: string): boolean {
	return value.startsWith(BROWSER_SEAL_PREFIX);
}

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

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () =>
			reject(new BrowserSealUnavailableError("The browser key store failed"));
	});
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		transaction.oncomplete = () => resolve();
		const fail = () =>
			reject(new BrowserSealUnavailableError("The browser key store failed"));
		transaction.onabort = fail;
		transaction.onerror = fail;
	});
}

function isUsableKey(key: unknown): key is CryptoKey {
	return (
		key instanceof CryptoKey &&
		key.type === "secret" &&
		!key.extractable &&
		key.algorithm.name === "AES-GCM"
	);
}

/**
 * Load (or create once) this origin's non-extractable device key. Exported for
 * the content sealer (`content-seal.ts`), which seals under its own purposes. The read and
 * the first write share one read-write transaction, so two tabs racing on first
 * use converge on a single key.
 */
export async function loadBrowserDeviceKey(): Promise<CryptoKey> {
	if (!(globalThis.indexedDB && globalThis.crypto?.subtle)) {
		throw new BrowserSealUnavailableError();
	}
	const open = indexedDB.open(DATABASE, 1);
	open.onupgradeneeded = () => {
		open.result.createObjectStore(STORE);
	};
	const db = await requestResult(open);
	try {
		const candidate = await crypto.subtle.generateKey(
			{ name: "AES-GCM", length: 256 },
			false,
			["encrypt", "decrypt"]
		);
		const transaction = db.transaction(STORE, "readwrite");
		const done = transactionDone(transaction);
		const store = transaction.objectStore(STORE);
		const existing: unknown = await requestResult(store.get(DEVICE_KEY));
		if (existing !== undefined && !isUsableKey(existing)) {
			transaction.abort();
			await done.catch(() => undefined);
			throw new BrowserSealUnavailableError(
				"The browser encryption key is invalid"
			);
		}
		const key = isUsableKey(existing) ? existing : candidate;
		if (existing === undefined) {
			store.put(key, DEVICE_KEY);
		}
		await done;
		return key;
	} finally {
		db.close();
	}
}

/** Seals and opens strings with one key; each call names the slot it is for. */
export class BrowserSealer {
	private keyPromise: Promise<CryptoKey> | null = null;
	private readonly keyProvider: () => Promise<CryptoKey>;

	constructor(keyProvider: () => Promise<CryptoKey>) {
		this.keyProvider = keyProvider;
	}

	private key(): Promise<CryptoKey> {
		if (!this.keyPromise) {
			this.keyPromise = this.keyProvider();
			// A failure is not cached: a later call retries.
			this.keyPromise.catch(() => {
				this.keyPromise = null;
			});
		}
		return this.keyPromise;
	}

	/** Seal `plaintext` for `purpose`. Throws {@link BrowserSealUnavailableError}. */
	async seal(plaintext: string, purpose: string): Promise<string> {
		const key = await this.key();
		const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
		const ciphertext = await crypto.subtle.encrypt(
			{
				name: "AES-GCM",
				iv,
				additionalData: new TextEncoder().encode(purpose),
			},
			key,
			new TextEncoder().encode(plaintext)
		);
		const envelope = new Uint8Array(IV_BYTES + ciphertext.byteLength);
		envelope.set(iv, 0);
		envelope.set(new Uint8Array(ciphertext), IV_BYTES);
		return `${BROWSER_SEAL_PREFIX}${toBase64(envelope)}`;
	}

	/**
	 * Open a value sealed for `purpose`. A value that does not carry the prefix
	 * is refused: callers decide explicitly how to treat legacy plaintext.
	 */
	async open(stored: string, purpose: string): Promise<string> {
		if (!looksBrowserSealed(stored)) {
			throw new BrowserSealUnavailableError("The stored value is not sealed");
		}
		const envelope = fromBase64(stored.slice(BROWSER_SEAL_PREFIX.length));
		if (envelope.length <= IV_BYTES) {
			throw new BrowserSealUnavailableError("The sealed value is malformed");
		}
		const key = await this.key();
		const plaintext = await crypto.subtle
			.decrypt(
				{
					name: "AES-GCM",
					iv: envelope.slice(0, IV_BYTES),
					additionalData: new TextEncoder().encode(purpose),
				},
				key,
				envelope.slice(IV_BYTES)
			)
			.catch(() => {
				throw new BrowserSealUnavailableError(
					"The sealed value could not be opened in this browser"
				);
			});
		return new TextDecoder().decode(plaintext);
	}
}

/** The sealer for this browser origin, keyed by its IndexedDB device key. */
export const browserSealer = new BrowserSealer(loadBrowserDeviceKey);
