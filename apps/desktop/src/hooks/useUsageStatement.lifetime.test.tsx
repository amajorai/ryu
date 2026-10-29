import { expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { UsageFilters } from "@/src/lib/api/credits.ts";

if (globalThis.document === undefined) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
let org = "one";
mock.module("@/src/lib/api/orgs.ts", () => ({ useActiveOrgId: () => org }));
const reads: {
	filters: UsageFilters;
	signal?: AbortSignal;
	resolve: <TValue>(value: TValue) => void;
}[] = [];
mock.module("@/src/lib/api/credits.ts", () => ({
	fetchUsage: (filters: UsageFilters, signal?: AbortSignal) =>
		new Promise((resolve) => reads.push({ filters, signal, resolve })),
	// The hook wraps foreign failures in the client's error type; every read
	// here resolves, so a bare subclass suffices.
	CreditsError: class CreditsError extends Error {},
}));
const { useUsageStatement } = await import("./useUsageStatement.ts");

test("statement requests cancel superseded work, deduplicate pages and ignore late replies", async () => {
	const root = createRoot(document.createElement("div"));
	let latest: ReturnType<typeof useUsageStatement>;
	function Reader() {
		latest = useUsageStatement();
		return null;
	}
	const settle = async (index: number, id: string) =>
		act(async () =>
			reads[index].resolve({
				entries: [{ id }],
				stats: null,
				nextCursor: "next",
			})
		);
	try {
		await act(async () => root.render(<Reader />));
		await settle(0, "initial");
		await act(async () => {
			latest!.loadMore();
			latest!.loadMore();
		});
		expect(reads).toHaveLength(2);
		await act(async () => latest!.applyFilters({ provider: "new" }));
		expect(reads[1].signal?.aborted).toBe(true);
		expect(latest!.loadingMore).toBe(false);
		await act(async () => latest!.refresh());
		expect(reads[2].signal?.aborted).toBe(true);
		await settle(3, "current");
		await settle(2, "old-filter");
		await settle(1, "old-page");
		expect(latest!.entries.map((entry) => entry.id)).toEqual(["current"]);
		expect(latest!.loading).toBe(false);
		await act(async () => latest!.loadMore());
		org = "two";
		await act(async () => root.render(<Reader />));
		expect(reads[4].signal?.aborted).toBe(true);
		expect(latest!.entries).toEqual([]);
		await act(async () => root.render(null));
		expect(reads[5].signal?.aborted).toBe(true);
	} finally {
		await act(async () => root.unmount());
	}
});
