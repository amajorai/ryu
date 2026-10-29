import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Real storage, CSS, Intl and shipping module; only the denied platform write
// is injected. Storage signals below are a unit boundary, not OS delivery.
GlobalRegistrator.register();
let revision = 0;
let restoreWrite: (() => void) | undefined;
let unsubscribe: (() => void) | undefined;
async function independentStore(): Promise<
	typeof import("../../../../packages/ui/src/lib/timezone.ts")
> {
	return await import(
		`../../../../packages/ui/src/lib/timezone.ts?storage-proof-${++revision}`
	);
}
const instant = new Date("2026-01-15T00:30:00.000Z");
const options = { hour: "2-digit", minute: "2-digit", hour12: false } as const;
function clock(zone: string) {
	return new Intl.DateTimeFormat(undefined, {
		...options,
		timeZone: zone,
	}).format(instant);
}
async function settle() {
	await new Promise<void>((resolve) => setTimeout(resolve, 0));
}
beforeEach(() => {
	localStorage.clear();
	sessionStorage.clear();
	document.documentElement.style.removeProperty("--ryu-timezone");
	localStorage.setItem("ryu:timezone", "UTC");
	localStorage.setItem("unrelated", '{"retain":[1,2,3]}');
});
afterEach(() => {
	restoreWrite?.();
	restoreWrite = undefined;
	unsubscribe?.();
	unsubscribe = undefined;
});
afterAll(async () => {
	await GlobalRegistrator.unregister();
});

test("denied timezone writes acknowledge only the current session; retry becomes durable on independent reload", async () => {
	const store = await independentStore();
	const acknowledged: string[] = [];
	unsubscribe = store.subscribeTimezone(() =>
		acknowledged.push(store.formatTime(instant, options))
	);
	const nativeWrite = localStorage.setItem;
	let refusals = 0;
	Object.defineProperty(localStorage, "setItem", {
		configurable: true,
		value: (key: string, value: string) => {
			if (key === store.TIMEZONE_KEY) {
				refusals += 1;
				throw new DOMException("Timezone storage denied", "QuotaExceededError");
			}
			nativeWrite(key, value);
		},
	});
	restoreWrite = () =>
		Object.defineProperty(localStorage, "setItem", {
			configurable: true,
			value: nativeWrite,
		});
	store.setTimezonePreference("Asia/Tokyo");
	await settle();
	expect(refusals).toBe(1);
	expect(store.getTimezonePreference()).toBe("Asia/Tokyo");
	expect(store.formatTime(instant, options)).toBe(clock("Asia/Tokyo"));
	expect(acknowledged).toContain(clock("Asia/Tokyo"));
	expect(localStorage.getItem(store.TIMEZONE_KEY)).toBe("UTC");
	expect(localStorage.getItem("unrelated")).toBe('{"retain":[1,2,3]}');
	const reloadBeforeRetry = await independentStore();
	expect(reloadBeforeRetry.getTimezonePreference()).toBe("UTC");
	expect(reloadBeforeRetry.formatTime(instant, options)).toBe(clock("UTC"));
	restoreWrite();
	restoreWrite = undefined;
	store.setTimezonePreference("Asia/Tokyo");
	await settle();
	expect(localStorage.getItem(store.TIMEZONE_KEY)).toBe("Asia/Tokyo");
	const reloadAfterRetry = await independentStore();
	expect(reloadAfterRetry.getTimezonePreference()).toBe("Asia/Tokyo");
	expect(reloadAfterRetry.formatTime(instant, options)).toBe(
		clock("Asia/Tokyo")
	);
	expect(localStorage.getItem("unrelated")).toBe('{"retain":[1,2,3]}');
});

test("sessionStorage signals cannot replace a local preference; local signals acknowledge consumers and stop after unsubscribe", async () => {
	const store = await independentStore();
	const acknowledged: string[] = [];
	unsubscribe = store.subscribeTimezone(() =>
		acknowledged.push(store.formatTime(instant, options))
	);
	expect(store.getTimezonePreference()).toBe("UTC");
	localStorage.setItem(store.TIMEZONE_KEY, "America/Los_Angeles");
	for (const key of [store.TIMEZONE_KEY, null]) {
		window.dispatchEvent(
			new StorageEvent("storage", { key, storageArea: sessionStorage })
		);
		await settle();
		expect(store.getTimezonePreference()).toBe("UTC");
		expect(acknowledged).toEqual([]);
	}
	window.dispatchEvent(
		new StorageEvent("storage", {
			key: store.TIMEZONE_KEY,
			storageArea: localStorage,
		})
	);
	await settle();
	expect(store.getTimezonePreference()).toBe("America/Los_Angeles");
	expect(acknowledged).toEqual([clock("America/Los_Angeles")]);
	unsubscribe();
	unsubscribe = undefined;
	localStorage.setItem(store.TIMEZONE_KEY, "Asia/Tokyo");
	window.dispatchEvent(
		new StorageEvent("storage", {
			key: store.TIMEZONE_KEY,
			storageArea: localStorage,
		})
	);
	document.documentElement.style.setProperty("--ryu-timezone", "Asia/Tokyo");
	await settle();
	expect(acknowledged).toEqual([clock("America/Los_Angeles")]);
	expect(localStorage.getItem("unrelated")).toBe('{"retain":[1,2,3]}');
});
