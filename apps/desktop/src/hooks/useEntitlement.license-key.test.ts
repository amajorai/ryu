// A locked OS keychain must read as "locked", never as "no license key": the
// entitlement hook keeps its verdict and re-reads once the keychain opens.

import { afterAll, beforeEach, expect, mock, test } from "bun:test";

let secretReads: (() => Promise<string | null>)[] = [];

const nativeBoundary = await import("@/src/lib/tauri-ready.ts");
mock.module("@/src/lib/tauri-ready.ts", () => ({
	...nativeBoundary,
	invokeWhenReady: (command: string) => {
		if (command !== "desktop_secret_get") {
			throw new Error(`Unexpected native command: ${command}`);
		}
		const next = secretReads.shift();
		if (!next) {
			throw new Error("no scripted desktop_secret_get answer");
		}
		return next();
	},
	isNoDesktopBackend: () => false,
}));

const { readLicenseKey } = await import("./useEntitlement.ts");

beforeEach(() => {
	secretReads = [];
});

afterAll(() => {
	mock.module("@/src/lib/tauri-ready.ts", () => nativeBoundary);
});

test("a keychain that rejects reads as locked, not as no key", async () => {
	secretReads = [() => Promise.reject(new Error("keychain is locked"))];
	expect(await readLicenseKey()).toEqual({ status: "locked" });
});

test("the same slot read after the keychain unlocks returns the key", async () => {
	secretReads = [
		() => Promise.reject(new Error("keychain is locked")),
		() => Promise.resolve("enc-license-key"),
	];
	expect(await readLicenseKey()).toEqual({ status: "locked" });
	expect(await readLicenseKey()).toEqual({
		key: "enc-license-key",
		status: "ready",
	});
});
