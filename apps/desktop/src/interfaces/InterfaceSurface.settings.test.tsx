// The host's `InterfacePort.updateSettings`: what an interface may save about
// itself from inside its view. The real `InterfaceSurface` over the real tab
// system, with the Feed renderer replaced by one that hands its `port` to the
// test, so the host's own filter is what runs.
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
	type InterfaceDescriptor,
	type InterfacePort,
	interfaceSettingsFor,
} from "@ryuhq/protocol/interfaces";
import { QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

if (globalThis.document === undefined) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let capturedPort: InterfacePort | null = null;
mock.module("@ryu/blocks/desktop/interfaces/feed-interface.tsx", () => ({
	FeedInterface: ({ port }: { port: InterfacePort }) => {
		capturedPort = port;
		return <div data-testid="stub-feed" />;
	},
}));
mock.module("@/src/contexts/entitlement-context.tsx", () => ({
	useEntitlementContext: () => ({
		requestUpgrade: () => undefined,
		verdict: null,
	}),
}));
mock.module("@/src/lib/window-routing.ts", () => ({
	listenForEntityActivation: async () => () => undefined,
	registerWindowTabs: async () => undefined,
	tabEntityKey: () => null,
}));

function coreAnswer(input: Request | string | URL): Response {
	const path = new URL(
		typeof input === "string" || input instanceof URL ? input : input.url
	).pathname;
	const body =
		path === "/api/conversations"
			? { conversations: [] }
			: path === "/api/agents"
				? { agents: [] }
				: path === "/api/teams"
					? { teams: [] }
					: {};
	return new Response(JSON.stringify(body), {
		headers: { "content-type": "application/json" },
		status: path.startsWith("/api/") ? 200 : 404,
	});
}
globalThis.fetch = ((input: Request | string | URL) =>
	Promise.resolve(coreAnswer(input))) as typeof fetch;

const { InterfaceSurface } = await import("./InterfaceSurface.tsx");
const { BUILTIN_INTERFACES } = await import("./registry.ts");
const { TabsProvider } = await import("@/src/contexts/TabsContext.tsx");
const { ChatHistoryProvider } = await import(
	"@/src/contexts/ChatHistoryContext.tsx"
);
const { DesktopWorkbenchProvider } = await import(
	"@/src/workbench/DesktopWorkbenchContext.tsx"
);
const { queryClient } = await import("@/src/lib/query-client.ts");
const { useProductModeStore } = await import("@/src/lib/product-mode.ts");
const { useInterfaceSettings } = await import("./use-interface-settings.ts");

const FEED = BUILTIN_INTERFACES.find((entry) => entry.renderer === "feed");
if (!FEED) {
	throw new Error("the Feed interface is no longer built in");
}
const ORDER = interfaceSettingsFor(FEED).find((field) => field.key === "order");
if (!ORDER) {
	throw new Error("Feed no longer has an order setting");
}

function descriptorFor(id: string): InterfaceDescriptor {
	// Narrowed to one setting, as a Marketplace interface may do.
	return { ...FEED, id, settings: [ORDER] } as InterfaceDescriptor;
}

let container: HTMLDivElement;
let root: Root;

async function mount(descriptor: InterfaceDescriptor) {
	await act(async () =>
		root.render(
			<QueryClientProvider client={queryClient}>
				<DesktopWorkbenchProvider
					persistenceDelayMs={60_000}
					storage={localStorage}
				>
					<TabsProvider>
						<ChatHistoryProvider>
							<InterfaceSurface
								canSwitchToConsole={false}
								descriptor={descriptor}
							/>
						</ChatHistoryProvider>
					</TabsProvider>
				</DesktopWorkbenchProvider>
			</QueryClientProvider>
		)
	);
}

async function portReady(): Promise<InterfacePort> {
	for (let attempt = 0; attempt < 400 && !capturedPort; attempt++) {
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 10));
		});
	}
	if (!capturedPort) {
		throw new Error("the renderer never mounted");
	}
	return capturedPort;
}

const overrides = () => useInterfaceSettings.getState().overrides;

beforeEach(() => {
	localStorage.clear();
	useProductModeStore.getState().setOsAccess(true);
	useInterfaceSettings.setState({ overrides: {} });
	capturedPort = null;
	queryClient.clear();
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	queryClient.clear();
	useInterfaceSettings.setState({ overrides: {} });
});

describe("InterfacePort.updateSettings", () => {
	test("keeps only the descriptor's own settings whose values fit", async () => {
		await mount(descriptorFor("plugin:test:a"));
		const port = await portReady();
		await act(async () => {
			port.updateSettings?.({ bogus: 1, order: "active" });
		});
		expect(overrides()["plugin:test:a"]).toEqual({ order: "active" });

		// A value outside the field's options is rejected whole.
		await act(async () => {
			port.updateSettings?.({ order: "not-an-option" });
		});
		expect(overrides()["plugin:test:a"]).toEqual({ order: "active" });

		// A key the narrowed descriptor does not show is dropped, though the
		// renderer has the setting.
		await act(async () => {
			port.updateSettings?.({ workBubbles: true });
		});
		expect(overrides()["plugin:test:a"]).toEqual({ order: "active" });
	});

	test("an in-view save merges with a Settings edit of the same interface", async () => {
		await mount(descriptorFor("plugin:test:a"));
		const port = await portReady();
		act(() => {
			useInterfaceSettings
				.getState()
				.setSettings("plugin:test:a", { elsewhere: "kept" });
		});
		await act(async () => {
			port.updateSettings?.({ order: "recent" });
		});
		expect(overrides()["plugin:test:a"]).toEqual({
			elsewhere: "kept",
			order: "recent",
		});
	});

	test("a save after the descriptor is swapped lands on the new id only", async () => {
		await mount(descriptorFor("plugin:test:a"));
		const port = await portReady();
		await mount(descriptorFor("plugin:test:b"));
		await act(async () => {
			port.updateSettings?.({ order: "active" });
		});
		expect(overrides()["plugin:test:a"]).toBeUndefined();
		expect(overrides()["plugin:test:b"]).toEqual({ order: "active" });
	});
});
