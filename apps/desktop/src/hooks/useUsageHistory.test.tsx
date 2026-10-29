import { expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import type { HistoryImportReport } from "@/src/lib/api/usage-history.ts";

if (globalThis.document === undefined) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
mock.module("@/src/contexts/TabsContext.tsx", () => ({
	useIsActiveTab: () => true,
}));
class ApiError extends Error {
	status = 500;
	serverMessage = "";
}
mock.module("@/src/lib/api/client.ts", () => ({ ApiError }));
const pending: {
	target: ApiTarget;
	signal: AbortSignal;
	resolve: (value: HistoryImportReport) => void;
}[] = [];
const reads: string[] = [];
mock.module("@/src/lib/api/usage-history.ts", () => ({
	fetchUsageHistory: (target: ApiTarget) => {
		reads.push(target.url);
		return Promise.resolve({
			summary: { sessions: target.url === "http://node-a" ? 1 : 2 },
			sources: [],
		});
	},
	fetchUsageHistoryTracking: () => Promise.resolve({ enabled: false }),
	setUsageHistoryTracking: () => Promise.resolve({ enabled: true }),
	importUsageHistory: (
		target: ApiTarget,
		_body: Parameters<
			typeof import("@/src/lib/api/usage-history.ts").importUsageHistory
		>[1],
		signal: AbortSignal
	) =>
		new Promise<HistoryImportReport>((resolve) =>
			pending.push({ target, signal, resolve })
		),
	syncUsageHistoryAccount: () =>
		Promise.resolve({ report: null, nextCursor: null }),
}));
const { useUsageHistory } = await import("./useUsageHistory.ts");

test("aborts imports on node switch and ignores late results from the old node", async () => {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const root = createRoot(document.createElement("div"));
	let target: ApiTarget = { url: "http://node-a", token: "a" };
	let latest: ReturnType<typeof useUsageHistory> | undefined;
	function Reader() {
		latest = useUsageHistory(target, null);
		return null;
	}
	const render = async () => {
		await act(async () =>
			root.render(
				<QueryClientProvider client={client}>
					<Reader />
				</QueryClientProvider>
			)
		);
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 20));
		});
	};
	try {
		await render();
		let importPromise: Promise<void> | undefined;
		await act(async () => {
			importPromise = latest?.runImport({ sourceIds: ["codex"], roots: [] });
		});
		expect(pending).toHaveLength(1);
		target = { url: "http://node-b", token: "b" };
		await render();
		expect(pending[0]?.signal.aborted).toBe(true);
		expect(latest?.importing).toBe(false);
		await act(async () => {
			pending[0]?.resolve({
				scannedFiles: 1,
				importedRecords: 20,
				updatedRecords: 0,
				duplicateRecords: 0,
				skippedFiles: 0,
				errorCount: 0,
				errors: [],
				hasMore: false,
			});
			await importPromise;
		});
		expect(latest?.importReport).toBeNull();
		expect(latest?.report?.summary.sessions).toBe(2);
		const serializedKeys = JSON.stringify(
			client
				.getQueryCache()
				.getAll()
				.map((query) => query.queryKey)
		);
		expect(serializedKeys).not.toContain('"a"');
		expect(serializedKeys).not.toContain('"b"');
		expect(reads.filter((url) => url === "http://node-b")).toHaveLength(1);
	} finally {
		await act(async () => root.unmount());
		client.clear();
	}
});
