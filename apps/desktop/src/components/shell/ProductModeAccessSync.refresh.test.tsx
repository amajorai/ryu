// The app-entry access gate holds its splash for the first resolution only. The
// credits wallet reloads on every window focus and org switch; a reload after
// startup must keep the shell (and every open tab under it) mounted.
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";

if (globalThis.document === undefined) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const wallet = { loading: true };
const walletListeners = new Set<() => void>();
function setWalletLoading(loading: boolean) {
	wallet.loading = loading;
	for (const listener of walletListeners) {
		listener();
	}
}

const { useSyncExternalStore } = await import("react");
mock.module("@/src/hooks/useCreditsWallet.ts", () => ({
	useCreditsWallet: () => {
		const loading = useSyncExternalStore(
			(listener) => {
				walletListeners.add(listener);
				return () => walletListeners.delete(listener);
			},
			() => wallet.loading
		);
		return { entitlement: null, loading, refresh: async () => undefined };
	},
}));

const { ProductModeAccessSync } = await import("./ProductModeAccessSync.tsx");
const { queryClient } = await import("@/src/lib/query-client.ts");

let mounts = 0;
let unmounts = 0;
function ShellProbe() {
	useEffect(() => {
		mounts += 1;
		return () => {
			unmounts += 1;
		};
	}, []);
	return <div data-testid="shell" />;
}

let container: HTMLDivElement;
let root: Root;
const shell = () => container.querySelector('[data-testid="shell"]');

async function flush() {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
}

beforeEach(() => {
	mounts = 0;
	unmounts = 0;
	wallet.loading = true;
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
});

test("the splash covers the first access resolution, then a wallet reload keeps the shell mounted", async () => {
	await act(async () =>
		root.render(
			<QueryClientProvider client={queryClient}>
				<ProductModeAccessSync>
					<ShellProbe />
				</ProductModeAccessSync>
			</QueryClientProvider>
		)
	);
	await flush();
	expect(shell()).toBeNull();

	await act(async () => setWalletLoading(false));
	for (let attempt = 0; attempt < 100 && shell() === null; attempt++) {
		await flush();
	}
	expect(shell()).not.toBeNull();
	expect(mounts).toBe(1);

	// A focus-driven wallet reload: loading flips back on, then settles again.
	await act(async () => setWalletLoading(true));
	await flush();
	expect(shell()).not.toBeNull();
	await act(async () => setWalletLoading(false));
	await flush();

	expect(shell()).not.toBeNull();
	expect(mounts).toBe(1);
	expect(unmounts).toBe(0);
});
