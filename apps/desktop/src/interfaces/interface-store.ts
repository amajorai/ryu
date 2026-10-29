// Which interface the user picked, and the switch action every switcher uses.
//
// The product mode store (`lib/product-mode.ts`) still owns the tier (Bot,
// workspace, Console) and its access gate. This store only remembers WHICH
// workspace interface renders when the product mode is the workspace ("os"):
// the OS desktop, Channels, Feed, a world, or a Marketplace interface.
//
// The key is deliberately named "workspace interface". It is unrelated to the
// older `ryu:interface-level` preference (simple vs expert controls).

import {
	type InterfaceDescriptor,
	interfaceTier,
	isInterfaceId,
} from "@ryuhq/protocol/interfaces";
import { create } from "zustand";
import { setInterfaceLevel } from "@/src/lib/interface-level.ts";
import { isRyuBot } from "@/src/lib/product.ts";
import {
	type ProductMode,
	readStartupRealm,
	setProductMode,
	useProductMode,
	useProductModeStore,
} from "@/src/lib/product-mode.ts";
import { interfaceLevelForProductMode } from "@/src/lib/response-mode-prompt.ts";
import {
	availableInterfaces,
	initialWorkspaceInterfaceId,
	resolveActiveInterface,
} from "./registry.ts";

export const WORKSPACE_INTERFACE_KEY = "ryu:workspace-interface";

function storage(): Storage | null {
	try {
		return typeof localStorage === "undefined" ? null : localStorage;
	} catch {
		return null;
	}
}

function readStoredWorkspaceInterfaceId(): string | null {
	try {
		const stored = storage()?.getItem(WORKSPACE_INTERFACE_KEY) ?? null;
		return isInterfaceId(stored) ? stored : null;
	} catch {
		return null;
	}
}

const EMPTY_CONTRIBUTED: InterfaceDescriptor[] = [];

interface InterfaceState {
	/**
	 * Marketplace interfaces from enabled plugins, mirrored from the plugin
	 * contributions query by `useSyncContributedInterfaces()` so switchers that
	 * render outside the query provider (and the window title) can read them.
	 */
	contributed: InterfaceDescriptor[];
	setContributed: (contributed: InterfaceDescriptor[]) => void;
	setWorkspaceInterfaceId: (id: string) => void;
	setWorkspaceInterfaces: (enabled: boolean) => void;
	workspaceInterfaceId: string;
	/**
	 * Mirrors the `ui.workspace_interfaces` rollout flag (synced by the app's
	 * access gate): interfaces beyond the OS desktop. Starts false.
	 */
	workspaceInterfaces: boolean;
}

export const useInterfaceStore = create<InterfaceState>((set) => ({
	contributed: EMPTY_CONTRIBUTED,
	setContributed: (contributed) => set({ contributed }),
	setWorkspaceInterfaceId: (id) => {
		try {
			storage()?.setItem(WORKSPACE_INTERFACE_KEY, id);
		} catch {
			// Best-effort persistence; the in-memory choice remains authoritative.
		}
		set({ workspaceInterfaceId: id });
	},
	setWorkspaceInterfaces: (enabled) => set({ workspaceInterfaces: enabled }),
	workspaceInterfaceId: initialWorkspaceInterfaceId(
		readStartupRealm(),
		readStoredWorkspaceInterfaceId()
	),
	workspaceInterfaces: false,
}));

export function productModeFor(descriptor: InterfaceDescriptor): ProductMode {
	if (descriptor.renderer === "bot") {
		return "bot";
	}
	if (descriptor.renderer === "console") {
		return "console";
	}
	return "os";
}

/**
 * Switch to an interface. Bot and Console keep their exact product-mode
 * behavior; every other interface is the workspace tier rendered differently.
 */
export function selectInterface(descriptor: InterfaceDescriptor): void {
	const mode = productModeFor(descriptor);
	if (mode === "console") {
		useProductModeStore.getState().setConsoleAccess(true);
	}
	if (mode === "os") {
		useInterfaceStore.getState().setWorkspaceInterfaceId(descriptor.id);
	}
	setProductMode(mode);
	setInterfaceLevel(interfaceLevelForProductMode(mode));
}

/**
 * Switch to an interface by id on behalf of an agent request
 * (`workspace.switch_interface`). The id is applied only when the switcher
 * would offer it to this user right now: Console still needs Console access,
 * and workspace interfaces still need their rollout flags. Returns whether the
 * switch happened.
 */
export function selectInterfaceById(id: string): boolean {
	const { consoleAccess, osAccess } = useProductModeStore.getState();
	const { contributed, workspaceInterfaces } = useInterfaceStore.getState();
	const descriptor = availableInterfaces({
		canSwitchToConsole: consoleAccess,
		canSwitchToOs: !isRyuBot() && osAccess,
		contributed,
		workspaceInterfaces,
	}).find((option) => option.id === id);
	if (!descriptor) {
		return false;
	}
	selectInterface(descriptor);
	return true;
}

/** The interface the shell renders right now. */
export function useActiveInterface(
	contributed: readonly InterfaceDescriptor[]
): InterfaceDescriptor {
	const productMode = useProductMode();
	const workspaceInterfaceId = useInterfaceStore(
		(state) => state.workspaceInterfaceId
	);
	const workspaceInterfaces = useInterfaceStore(
		(state) => state.workspaceInterfaces
	);
	return resolveActiveInterface({
		contributed,
		productMode,
		workspaceInterfaceId,
		workspaceInterfaces,
	});
}

/** {@link useActiveInterface} over the mirrored Marketplace list. */
export function useActiveInterfaceFromStore(): InterfaceDescriptor {
	const contributed = useInterfaceStore((state) => state.contributed);
	return useActiveInterface(contributed);
}

/**
 * True while a workspace interface other than the OS desktop is selected
 * (Channels, Feed, a world, a layout, or a Marketplace interface). Those render
 * from the interface snapshot, whose excerpts and waiting/quiet status need the
 * conversation list's message previews.
 */
export function useInterfaceSurfaceSelected(): boolean {
	const renderer = useActiveInterfaceFromStore().renderer;
	return renderer !== "os" && interfaceTier(renderer) === "workspace";
}
