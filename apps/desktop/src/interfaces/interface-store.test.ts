import { beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
const memory = globalThis.localStorage;
memory.clear();
memory.setItem("ryu:workspace-interface", "ryu:feed");

type StoreModule = typeof import("./interface-store.ts");
type RegistryModule = typeof import("./registry.ts");
type ProductModeModule = typeof import("@/src/lib/product-mode.ts");
type InterfaceLevelModule = typeof import("@/src/lib/interface-level.ts");

let store: StoreModule;
let registry: RegistryModule;
let productMode: ProductModeModule;
let interfaceLevel: InterfaceLevelModule;

beforeAll(async () => {
	// Import after seeding storage so the stores read it at creation.
	store = await import("./interface-store.ts");
	registry = await import("./registry.ts");
	productMode = await import("@/src/lib/product-mode.ts");
	interfaceLevel = await import("@/src/lib/interface-level.ts");
});

function descriptor(label: string) {
	const found = registry.BUILTIN_INTERFACES.find(
		(entry) => entry.label === label
	);
	if (!found) {
		throw new Error(`missing built-in ${label}`);
	}
	return found;
}

describe("interface store", () => {
	test("restores the remembered workspace interface for the last-used realm", () => {
		expect(store.useInterfaceStore.getState().workspaceInterfaceId).toBe(
			"ryu:feed"
		);
	});

	test("a workspace interface selects the workspace mode and is remembered", () => {
		store.selectInterface(descriptor("Channels"));
		expect(productMode.useProductModeStore.getState().requestedMode).toBe("os");
		expect(store.useInterfaceStore.getState().workspaceInterfaceId).toBe(
			"ryu:channels"
		);
		expect(memory.getItem(store.WORKSPACE_INTERFACE_KEY)).toBe("ryu:channels");
		expect(interfaceLevel.readInterfaceLevel()).toBe("expert");
	});

	test("Bot and Console keep the remembered workspace interface", () => {
		store.selectInterface(descriptor("Bot"));
		expect(productMode.useProductModeStore.getState().requestedMode).toBe(
			"bot"
		);
		expect(interfaceLevel.readInterfaceLevel()).toBe("simple");
		store.selectInterface(descriptor("Agent"));
		const modeState = productMode.useProductModeStore.getState();
		expect(modeState.requestedMode).toBe("console");
		expect(modeState.consoleAccess).toBe(true);
		expect(store.useInterfaceStore.getState().workspaceInterfaceId).toBe(
			"ryu:channels"
		);
		expect(interfaceLevel.readInterfaceLevel()).toBe("expert");
	});

	test("an agent switch applies only interfaces the switcher would offer", () => {
		const modeStore = productMode.useProductModeStore;
		const interfaceStore = store.useInterfaceStore;
		store.selectInterface(descriptor("Bot"));
		modeStore.getState().setConsoleAccess(false);
		modeStore.getState().setOsAccess(false);
		interfaceStore.getState().setWorkspaceInterfaces(false);

		// Nothing beyond Bot is rolled out or granted yet.
		expect(store.selectInterfaceById("ryu:console")).toBe(false);
		expect(store.selectInterfaceById("ryu:feed")).toBe(false);
		expect(store.selectInterfaceById("ryu:os")).toBe(false);
		expect(modeStore.getState().requestedMode).toBe("bot");

		// The OS desktop is rolled out, the other workspace interfaces are not.
		modeStore.getState().setOsAccess(true);
		expect(store.selectInterfaceById("ryu:feed")).toBe(false);
		expect(store.selectInterfaceById("ryu:os")).toBe(true);
		expect(modeStore.getState().requestedMode).toBe("os");

		interfaceStore.getState().setWorkspaceInterfaces(true);
		expect(store.selectInterfaceById("ryu:feed")).toBe(true);
		expect(interfaceStore.getState().workspaceInterfaceId).toBe("ryu:feed");

		// Console still requires Console access; an unknown id is ignored.
		expect(store.selectInterfaceById("ryu:console")).toBe(false);
		expect(store.selectInterfaceById("acme:not-installed")).toBe(false);
		expect(interfaceStore.getState().workspaceInterfaceId).toBe("ryu:feed");
		modeStore.getState().setConsoleAccess(true);
		expect(store.selectInterfaceById("ryu:console")).toBe(true);
		expect(modeStore.getState().requestedMode).toBe("console");
	});
});
