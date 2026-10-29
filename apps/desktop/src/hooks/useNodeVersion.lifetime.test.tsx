import { expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";

if (globalThis.document === undefined) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const reads: { jwt: string; signal?: AbortSignal }[] = [];
mock.module("@/src/components/updater/AutoUpdater.tsx", () => ({
	applyReleaseUpdate: async () => undefined,
}));
mock.module("@/src/lib/api/update.ts", () => ({
	getVersionInfo: (target: { userJwt: string }, signal?: AbortSignal) =>
		new Promise(() => reads.push({ jwt: target.userJwt, signal })),
	checkForUpdate: (
		target: { userJwt: string },
		options?: { signal?: AbortSignal }
	) =>
		new Promise(() =>
			reads.push({ jwt: target.userJwt, signal: options?.signal })
		),
}));
const { useNodeVersion } = await import("./useNodeVersion.ts");

test("version readers share scoped requests and release them when disabled", async () => {
	let target = { url: "http://node.test", token: "test-token", userJwt: "one" };
	let enabled = true;
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const root = createRoot(document.createElement("div"));
	function Reader() {
		useNodeVersion(target, enabled);
		return null;
	}
	const render = () =>
		root.render(
			<QueryClientProvider client={client}>
				<Reader />
				<Reader />
			</QueryClientProvider>
		);
	try {
		await act(async () => render());
		expect(reads).toHaveLength(2);
		target = { ...target, userJwt: "two" };
		await act(async () => render());
		expect(reads).toHaveLength(4);
		expect(reads.slice(0, 2).every((read) => read.signal?.aborted)).toBe(true);
		expect(reads.slice(2).every((read) => read.jwt === "two")).toBe(true);
		enabled = false;
		await act(async () => render());
		expect(reads.slice(2).every((read) => read.signal?.aborted)).toBe(true);
		expect(
			client
				.getQueryCache()
				.getAll()
				.every((query) => query.getObserversCount() === 0)
		).toBe(true);
	} finally {
		await act(async () => root.unmount());
		client.clear();
	}
});
