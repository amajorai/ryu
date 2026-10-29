// packages/services/src/webhooks/crypto.ts
//
// The few primitives the webhook verifiers need, on WebCrypto and the
// standard `atob`/`btoa`/`TextEncoder` globals only, so the module runs
// unchanged on Node 18+, Bun, Deno, Cloudflare Workers and Vercel Edge.
// Nothing here imports `node:*`.

const encoder = new TextEncoder();

/** Strict, padded base64 (the grammar the Mail signers accept for a `whsec_` key). */
const STRICT_BASE64_RE =
	/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** Bytes of a string (UTF-8) or a copy-free view of existing bytes. */
export function toBytes(value: string | Uint8Array): Uint8Array {
	return typeof value === "string" ? encoder.encode(value) : value;
}

/** Concatenates byte arrays into one fresh array. */
export function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
	let length = 0;
	for (const part of parts) {
		length += part.byteLength;
	}
	const joined = new Uint8Array(length);
	let offset = 0;
	for (const part of parts) {
		joined.set(part, offset);
		offset += part.byteLength;
	}
	return joined;
}

/**
 * Decodes strict, padded base64 to bytes, or returns null when `value` is
 * empty or not strict base64 (so a malformed secret is reported, not guessed).
 */
export function decodeBase64(value: string): Uint8Array | null {
	if (!(value && STRICT_BASE64_RE.test(value))) {
		return null;
	}
	const binary = atob(value);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index++) {
		bytes[index] = binary.charCodeAt(index);
	}
	return bytes;
}

/** Standard (padded) base64 of `bytes`. */
export function encodeBase64(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary);
}

/** Lowercase hex of `bytes`. */
export function encodeHex(bytes: Uint8Array): string {
	let hex = "";
	for (const byte of bytes) {
		hex += byte.toString(16).padStart(2, "0");
	}
	return hex;
}

/** The WebCrypto `SubtleCrypto`, or null on a runtime without it. */
function subtleCrypto(): SubtleCrypto | null {
	return globalThis.crypto?.subtle ?? null;
}

/** Whether this runtime exposes WebCrypto `crypto.subtle`. */
export function hasWebCrypto(): boolean {
	return subtleCrypto() !== null;
}

/**
 * HMAC-SHA256 of `message` under `key`, via `crypto.subtle`. Callers check
 * {@link hasWebCrypto} first; this rejects when WebCrypto is missing.
 */
export async function hmacSha256(
	key: Uint8Array,
	message: Uint8Array
): Promise<Uint8Array> {
	const subtle = subtleCrypto();
	if (!subtle) {
		throw new Error("WebCrypto crypto.subtle is not available");
	}
	// Copy into fresh ArrayBuffers so SharedArrayBuffer-backed views are never passed in.
	const cryptoKey = await subtle.importKey(
		"raw",
		new Uint8Array(key),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"]
	);
	const signature = await subtle.sign(
		"HMAC",
		cryptoKey,
		new Uint8Array(message)
	);
	return new Uint8Array(signature);
}

/**
 * Compares two strings in time that depends only on their lengths, never on
 * where they first differ. Unequal lengths still walk the longer input.
 */
export function timingSafeEqual(left: string, right: string): boolean {
	const a = encoder.encode(left);
	const b = encoder.encode(right);
	const length = Math.max(a.byteLength, b.byteLength);
	let difference = a.byteLength ^ b.byteLength;
	for (let index = 0; index < length; index++) {
		difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
	}
	return difference === 0;
}
