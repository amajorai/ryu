import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";

if (globalThis.document === undefined) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

// An org switch must re-key a mounted flag reader: the previous org's value
// stops being served at once and a refresh for the new org starts immediately,
// without waiting out the TTL. Only the auth vault and the billing client are
// replaced; the real app query client carries the active org.

const TOKEN_KEY = "ryu_session_token";
// Any client flag whose compiled default is OFF; `cloud_tasks.box_backend` now
// defaults ON, so it can no longer stand in for "never read means false".
const DEFAULT_OFF_FLAG = "family.hub";
const pendingSnapshots: Array<
	(value: { features: Record<string, boolean> }) => void
> = [];

const storage = new Map<string, string>([[TOKEN_KEY, "token"]]);
const originalLocalStorage = globalThis.localStorage;
Object.defineProperty(globalThis, "localStorage", {
	configurable: true,
	value: {
		getItem: (key: string) => storage.get(key) ?? null,
		removeItem: (key: string) => storage.delete(key),
		setItem: (key: string, value: string) => storage.set(key, value),
	},
});

mock.module("@/lib/auth-client.ts", () => ({
	BACKEND_URL: "https://control.example",
	getActiveUserId: () => "user-a",
	TOKEN_KEY,
	getActiveToken: () => globalThis.localStorage?.getItem(TOKEN_KEY) ?? null,
}));
mock.module("@/src/lib/api/billing.ts", () => ({
	fetchEntitlementSnapshot: () =>
		new Promise((resolve) => {
			pendingSnapshots.push(resolve);
		}),
}));

const { activeOrgQueryKey } = await import("@/src/lib/api/orgs.ts");
const ACTIVE_ORG = activeOrgQueryKey("user-a");
const { queryClient } = await import("@/src/lib/query-client.ts");
const { useFeatureFlag, useFeatureFlagState } = await import(
	"./useFeatureFlag.ts"
);
const { captureFeatureFlagScope, publishFeatureFlags } = await import(
	"@/src/lib/feature-flags.ts"
);

let root = createRoot(document.createElement("div"));
afterEach(async () => {
	await act(async () => root.unmount());
	root = createRoot(document.createElement("div"));
});
afterAll(() => {
	Object.defineProperty(globalThis, "localStorage", {
		configurable: true,
		value: originalLocalStorage,
	});
});

test("an org switch drops the old org's flag and refetches for the new org", async () => {
	queryClient.setQueryData(ACTIVE_ORG, "org-admin");
	const seen: boolean[] = [];
	function Reader() {
		seen.push(useFeatureFlag(DEFAULT_OFF_FLAG));
		return null;
	}

	await act(async () => root.render(<Reader />));
	expect(pendingSnapshots).toHaveLength(1);
	await act(async () => {
		pendingSnapshots.shift()?.({ features: { [DEFAULT_OFF_FLAG]: true } });
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
	expect(seen.at(-1)).toBe(true);

	await act(async () => {
		queryClient.setQueryData(ACTIVE_ORG, "org-member");
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
	// The admin org's `true` is gone before the new org has answered, and the
	// new org's request is already in flight.
	expect(seen.at(-1)).toBe(false);
	expect(pendingSnapshots).toHaveLength(1);

	await act(async () => {
		pendingSnapshots.shift()?.({ features: { [DEFAULT_OFF_FLAG]: false } });
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
	expect(seen.at(-1)).toBe(false);

	// Switching back restores that org's own last-known value at once, and still
	// revalidates it even though it is inside the TTL.
	await act(async () => {
		queryClient.setQueryData(ACTIVE_ORG, "org-admin");
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
	expect(seen.at(-1)).toBe(true);
	expect(pendingSnapshots).toHaveLength(1);
	await act(async () => {
		pendingSnapshots.shift()?.({ features: { [DEFAULT_OFF_FLAG]: false } });
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
	expect(seen.at(-1)).toBe(false);
});

test("a never-read scope is unsettled until its first refresh, and later publications reach mounted readers", async () => {
	queryClient.setQueryData(ACTIVE_ORG, "org-fresh");
	const seen: { enabled: boolean; settled: boolean }[] = [];
	function Reader() {
		seen.push(useFeatureFlagState(DEFAULT_OFF_FLAG));
		return null;
	}

	await act(async () => root.render(<Reader />));
	// Only the compiled-in default is known, and the first refresh is in flight.
	expect(seen.at(-1)).toEqual({ enabled: false, settled: false });
	expect(pendingSnapshots).toHaveLength(1);
	await act(async () => {
		pendingSnapshots.shift()?.({ features: { [DEFAULT_OFF_FLAG]: false } });
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
	expect(seen.at(-1)).toEqual({ enabled: false, settled: true });

	// Another publisher (the app-entry entitlement resolve) serves a flip; the
	// reader stays mounted and follows it without remounting.
	const scope = await captureFeatureFlagScope();
	await act(async () => {
		publishFeatureFlags({ [DEFAULT_OFF_FLAG]: true }, scope);
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
	expect(seen.at(-1)).toEqual({ enabled: true, settled: true });
});
