// The interface switcher, mounted with the real product-mode gate that mirrors
// the rollout flags into its options. Only the control plane's flag snapshot
// (the network boundary), the signed-in account the flag cache scopes by, and the
// clock are replaced: a long-lived session ages its cached flags past the TTL
// without waiting a real minute.
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
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
const TTL_MS = 60_000;

let account = "switcher-account";
const realAuthClient = { ...(await import("@/lib/auth-client.ts")) };
mock.module("@/lib/auth-client.ts", () => ({
	...realAuthClient,
	getActiveUserId: () => account,
}));

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

const { SidebarBrandBadge } = await import("./SidebarBrandBadge.tsx");
const { ProductModeAccessSync } = await import(
	"@/src/components/shell/ProductModeAccessSync.tsx"
);
const { queryClient } = await import("@/src/lib/query-client.ts");
const { useProductModeStore } = await import("@/src/lib/product-mode.ts");
const { useNodeStore } = await import("@/src/store/useNodeStore.ts");
const { captureFeatureFlagScope, publishFeatureFlags } = await import(
	"@/src/lib/feature-flags.ts"
);

const realNow = Date.now;
let clockOffsetMs = 0;
let container: HTMLDivElement;
let root: Root;

async function flush() {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 10));
	});
}

const trigger = () =>
	container.querySelector<HTMLElement>('[data-testid="product-mode-trigger"]');
const optionLabels = () =>
	[...document.querySelectorAll('[role="menuitemradio"]')].map(
		(item) => item.querySelector(".font-medium")?.textContent ?? ""
	);

async function toggleSwitcher() {
	const button = trigger();
	if (!button) {
		throw new Error("the interface switcher is not rendered");
	}
	await act(async () => {
		button.click();
		await new Promise((resolve) => setTimeout(resolve, 20));
	});
}

beforeEach(async () => {
	account = `account-${crypto.randomUUID()}`;
	clockOffsetMs = 0;
	Date.now = () => realNow() + clockOffsetMs;
	useNodeStore.setState({ hydrateCloudNodes: async () => undefined });
	useProductModeStore.setState({
		consoleAccess: false,
		osAccess: false,
		requestedMode: "os",
	});
	// A flag map fetched a moment ago: OS is on, the other workspace
	// interfaces are not rolled out yet.
	publishFeatureFlags(
		{ [OS_FLAG]: true, [WORKSPACE_FLAG]: false },
		await captureFeatureFlagScope()
	);
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	await act(async () =>
		root.render(
			<QueryClientProvider client={queryClient}>
				<ProductModeAccessSync>
					<SidebarBrandBadge canSwitchToConsole={false} canSwitchToOs />
				</ProductModeAccessSync>
			</QueryClientProvider>
		)
	);
	for (let attempt = 0; attempt < 100 && trigger() === null; attempt++) {
		await flush();
	}
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	Date.now = realNow;
	pendingSnapshots.length = 0;
});

test("opening the switcher inside the TTL offers what the cached flags allow and asks the control plane nothing", async () => {
	expect(trigger()).not.toBeNull();
	// Mounting read a fresh record, so nothing was requested.
	expect(pendingSnapshots).toHaveLength(0);

	await toggleSwitcher();

	expect(optionLabels()).toEqual(["Bot", "OS"]);
	expect(pendingSnapshots).toHaveLength(0);
});

test("opening the switcher after the TTL revalidates the rollout flags, and a newly rolled-out interface appears without a restart", async () => {
	expect(pendingSnapshots).toHaveLength(0);
	// The session stays open past the flags' TTL; the control plane has since
	// switched the other workspace interfaces on.
	clockOffsetMs = TTL_MS + 1000;

	await toggleSwitcher();

	expect(pendingSnapshots).toHaveLength(1);
	// Until the answer lands the menu offers only what it already knew.
	expect(optionLabels()).toEqual(["Bot", "OS"]);

	await act(async () => {
		pendingSnapshots.shift()?.({
			features: { [OS_FLAG]: true, [WORKSPACE_FLAG]: true },
		});
		await new Promise((resolve) => setTimeout(resolve, 10));
	});
	await flush();

	expect(optionLabels()).toContain("Feed");
	expect(optionLabels()).toContain("Channels");
});
