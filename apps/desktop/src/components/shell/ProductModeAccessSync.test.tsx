// The app-entry product-mode gate, mounted whole: the real `ProductModeAccessSync`
// over the real product-mode and interface stores, the real rollout-flag cache
// and hooks, and the real console-access and credits hooks. Only the control
// plane's flag snapshot (the network boundary) is replaced, plus the signed-in
// account the flag cache scopes by.
//
// The first test is a true cold start: the stores are imported after the previous
// session's choice is written to storage, exactly as a relaunch reads it.
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

if (globalThis.document === undefined) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const OS_FLAG = "ui.interface_os";
const WORKSPACE_FLAG = "ui.workspace_interfaces";
const PRODUCT_MODE_KEY = "ryu:product-mode";

// The previous session ended in the OS desktop with Feed picked.
localStorage.clear();
localStorage.setItem(PRODUCT_MODE_KEY, "os");
localStorage.setItem("ryu:workspace-interface", "ryu:feed");

let account = "cold-start-account";
const realAuthClient = { ...(await import("@/lib/auth-client.ts")) };
mock.module("@/lib/auth-client.ts", () => ({
	...realAuthClient,
	getActiveUserId: () => account,
}));

// Each call to the control plane's flag snapshot waits here until a test
// answers it, so the unsettled window is observable.
interface Snapshot {
	features: Record<string, boolean>;
	organizationId?: string | null;
}
const pendingSnapshots: Array<(value: Snapshot | null) => void> = [];
const realBilling = { ...(await import("@/src/lib/api/billing.ts")) };
mock.module("@/src/lib/api/billing.ts", () => ({
	...realBilling,
	fetchEntitlementSnapshot: () =>
		new Promise((resolve) => {
			pendingSnapshots.push(resolve);
		}),
}));

const { ProductModeAccessSync } = await import("./ProductModeAccessSync.tsx");
const { queryClient } = await import("@/src/lib/query-client.ts");
const { useProductMode, useProductModeStore } = await import(
	"@/src/lib/product-mode.ts"
);
const { useActiveInterfaceFromStore, useInterfaceStore } = await import(
	"@/src/interfaces/interface-store.ts"
);
const { useNodeStore } = await import("@/src/store/useNodeStore.ts");
const { captureFeatureFlagScope, publishFeatureFlags } = await import(
	"@/src/lib/feature-flags.ts"
);

// What the gate lets the shell render.
function ShellProbe() {
	const mode = useProductMode();
	const active = useActiveInterfaceFromStore();
	return (
		<div data-interface={active.id} data-mode={mode} data-testid="shell" />
	);
}

let container: HTMLDivElement;
let root: Root;

const shell = () => container.querySelector('[data-testid="shell"]');
const shownMode = () => shell()?.getAttribute("data-mode") ?? null;
const shownInterface = () => shell()?.getAttribute("data-interface") ?? null;
const storedMode = () => localStorage.getItem(PRODUCT_MODE_KEY);

async function flush() {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
}

async function mountGate() {
	await act(async () =>
		root.render(
			<QueryClientProvider client={queryClient}>
				<ProductModeAccessSync>
					<ShellProbe />
				</ProductModeAccessSync>
			</QueryClientProvider>
		)
	);
	// The gate shows its spinner until cloud nodes and the wallet settle.
	for (let attempt = 0; attempt < 100 && shell() === null; attempt++) {
		await flush();
	}
	if (shell() === null) {
		throw new Error("the gate never rendered the shell");
	}
}

async function answerFlags(features: Record<string, boolean>) {
	await act(async () => {
		pendingSnapshots.shift()?.({ features });
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
	await flush();
}

beforeEach(() => {
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	pendingSnapshots.length = 0;
});

describe("product-mode gate on a cold start", () => {
	test("the remembered OS choice is restored, kept while the flag is unsettled, and applied when the flag says yes", async () => {
		// Restored from storage when the stores were created.
		expect(useProductModeStore.getState().requestedMode).toBe("os");
		expect(useInterfaceStore.getState().workspaceInterfaceId).toBe("ryu:feed");
		useNodeStore.setState({ hydrateCloudNodes: async () => undefined });

		await mountGate();

		// The flag has never been read for this account and its first answer is
		// still on the wire. A local node is Console-only, so the gate would
		// replace the remembered OS choice with Console if it took the flag's
		// compiled-in `false` for an answer.
		expect(pendingSnapshots).toHaveLength(1);
		expect(storedMode()).toBe("os");
		expect(useProductModeStore.getState().requestedMode).toBe("os");
		expect(useProductModeStore.getState().consoleAccess).toBe(false);
		// Console is not exposed in the meantime either.
		expect(shownMode()).not.toBe("console");

		// The control plane says OS and the workspace interfaces are rolled out.
		await answerFlags({ [OS_FLAG]: true, [WORKSPACE_FLAG]: true });
		expect(shownMode()).toBe("os");
		expect(shownInterface()).toBe("ryu:feed");
		expect(storedMode()).toBe("os");
	});
});

describe("product-mode gate once the flag has an answer", () => {
	beforeEach(() => {
		account = `account-${crypto.randomUUID()}`;
		localStorage.setItem(PRODUCT_MODE_KEY, "os");
		useProductModeStore.setState({
			consoleAccess: false,
			osAccess: false,
			requestedMode: "os",
		});
		useInterfaceStore.setState({
			workspaceInterfaceId: "ryu:feed",
			workspaceInterfaces: false,
		});
		useNodeStore.setState({ hydrateCloudNodes: async () => undefined });
	});

	test("an answer of no replaces the remembered OS choice with Console", async () => {
		await mountGate();
		expect(storedMode()).toBe("os");

		await answerFlags({ [OS_FLAG]: false });

		expect(useProductModeStore.getState().requestedMode).toBe("console");
		expect(storedMode()).toBe("console");
		expect(shownMode()).toBe("console");
	});

	test("the remembered Feed waits behind OS until the workspace interfaces are rolled out, then returns without a relaunch", async () => {
		await mountGate();
		await answerFlags({ [OS_FLAG]: true, [WORKSPACE_FLAG]: false });

		// OS is on, the other workspace interfaces are not: the OS desktop renders
		// and the remembered choice is neither shown nor rewritten.
		expect(shownMode()).toBe("os");
		expect(shownInterface()).toBe("ryu:os");
		expect(useInterfaceStore.getState().workspaceInterfaceId).toBe("ryu:feed");
		expect(localStorage.getItem("ryu:workspace-interface")).toBe("ryu:feed");

		// Another surface fetches a newer map; the mounted gate follows it.
		const scope = await captureFeatureFlagScope();
		await act(async () => {
			publishFeatureFlags({ [OS_FLAG]: true, [WORKSPACE_FLAG]: true }, scope);
		});
		expect(shownInterface()).toBe("ryu:feed");
	});

	/** The record an earlier launch stored, aged past its TTL so a refresh is due. */
	async function storeAgedFlags(features: Record<string, boolean>) {
		const scope = await captureFeatureFlagScope();
		const realNow = Date.now;
		Date.now = () => realNow() - 10 * 60_000;
		try {
			publishFeatureFlags(features, scope);
		} finally {
			Date.now = realNow;
		}
	}

	test("a last-known yes from an earlier launch shows OS at once, while the refresh is still on the wire", async () => {
		await storeAgedFlags({ [OS_FLAG]: true, [WORKSPACE_FLAG]: true });

		await mountGate();

		expect(pendingSnapshots).toHaveLength(1);
		expect(shownMode()).toBe("os");
		expect(shownInterface()).toBe("ryu:feed");
		expect(storedMode()).toBe("os");
	});

	test("a last-known no is already an answer, so the gate does not wait on the refresh", async () => {
		await storeAgedFlags({ [OS_FLAG]: false });

		await mountGate();

		// The refresh has not answered, yet the stored `false` is authoritative.
		expect(pendingSnapshots).toHaveLength(1);
		expect(storedMode()).toBe("console");
		expect(shownMode()).toBe("console");
	});
});
