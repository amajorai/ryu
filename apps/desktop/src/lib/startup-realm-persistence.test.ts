import { expect, test } from "bun:test";
import {
	readStartupRealm,
	STARTUP_REALM_KEY,
	setStartupRealm,
} from "./product-mode.ts";

test("startup realm acknowledges only confirmed writes and retries refused or unavailable storage", () => {
	const descriptor = Object.getOwnPropertyDescriptor(
		globalThis,
		"localStorage"
	);
	const values = new Map<string, string>([[STARTUP_REALM_KEY, "bot"]]);
	let mode: "saved" | "refused" | "discarded" | "unreadable" = "refused";
	const fakeStorage = {
		getItem: (key: string) => {
			if (mode === "unreadable") {
				throw new Error("read refused");
			}
			return values.get(key) ?? null;
		},
		setItem: (key: string, value: string) => {
			if (mode === "refused") {
				throw new Error("write refused");
			}
			if (mode !== "discarded") {
				values.set(key, value);
			}
		},
	};
	try {
		Object.defineProperty(globalThis, "localStorage", {
			configurable: true,
			value: fakeStorage,
		});
		expect(setStartupRealm("os").ok).toBe(false);
		expect(readStartupRealm()).toBe("bot");
		mode = "discarded";
		expect(setStartupRealm("os").ok).toBe(false);
		expect(values.get(STARTUP_REALM_KEY)).toBe("bot");
		mode = "unreadable";
		expect(setStartupRealm("os").ok).toBe(false);
		expect(values.get(STARTUP_REALM_KEY)).toBe("os");
		mode = "saved";
		expect(setStartupRealm("os")).toEqual({ ok: true, realm: "os" });
		expect(readStartupRealm()).toBe("os");
		Object.defineProperty(globalThis, "localStorage", {
			configurable: true,
			get: () => {
				throw new Error("storage unavailable");
			},
		});
		expect(setStartupRealm("console").ok).toBe(false);
	} finally {
		if (descriptor) {
			Object.defineProperty(globalThis, "localStorage", descriptor);
		} else {
			Reflect.deleteProperty(globalThis, "localStorage");
		}
	}
});
