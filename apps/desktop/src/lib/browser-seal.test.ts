import { describe, expect, it } from "bun:test";
import {
	BROWSER_SEAL_PREFIX,
	BrowserSealer,
	BrowserSealUnavailableError,
	browserSealer,
	looksBrowserSealed,
} from "./browser-seal.ts";

const SECRET = "bearer-0123456789-abcdef";

function memoryKey(): Promise<CryptoKey> {
	return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
		"encrypt",
		"decrypt",
	]);
}

describe("browser sealer", () => {
	it("round-trips a value and never carries the plaintext", async () => {
		const sealer = new BrowserSealer(memoryKey);
		const sealed = await sealer.seal(SECRET, "webapp:test");
		expect(looksBrowserSealed(sealed)).toBe(true);
		expect(sealed.startsWith(BROWSER_SEAL_PREFIX)).toBe(true);
		expect(sealed).not.toContain(SECRET);
		expect(atob(sealed.slice(BROWSER_SEAL_PREFIX.length))).not.toContain(
			SECRET
		);
		expect(await sealer.open(sealed, "webapp:test")).toBe(SECRET);
	});

	it("uses a fresh nonce for every seal", async () => {
		const sealer = new BrowserSealer(memoryKey);
		expect(await sealer.seal(SECRET, "p")).not.toBe(
			await sealer.seal(SECRET, "p")
		);
	});

	it("refuses a value moved to another slot, another key, or plaintext", async () => {
		const sealer = new BrowserSealer(memoryKey);
		const sealed = await sealer.seal(SECRET, "webapp:secret:auth-vault");
		await expect(
			sealer.open(sealed, "webapp:secret:license-key")
		).rejects.toBeInstanceOf(BrowserSealUnavailableError);
		await expect(
			new BrowserSealer(memoryKey).open(sealed, "webapp:secret:auth-vault")
		).rejects.toBeInstanceOf(BrowserSealUnavailableError);
		await expect(sealer.open(SECRET, "p")).rejects.toBeInstanceOf(
			BrowserSealUnavailableError
		);
	});

	it("fails closed without IndexedDB", async () => {
		expect(globalThis.indexedDB).toBeUndefined();
		await expect(browserSealer.seal(SECRET, "p")).rejects.toBeInstanceOf(
			BrowserSealUnavailableError
		);
	});
});
