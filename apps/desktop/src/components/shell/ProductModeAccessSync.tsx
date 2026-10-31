// The app-entry gate that turns server-backed access (organization role, rollout
// flags, managed inference) into the product mode and interface the shell may
// render. It lives in its own module so the cold-start and flag-settle rules can
// be mounted on their own; `App.tsx` wraps the main shell in it.
import {
	INTERFACE_OS_FLAG,
	WORKSPACE_INTERFACES_FLAG,
} from "@ryu/auth/lib/feature-flags";
import { Logo as OrbLogo } from "@ryu/ui/components/logo.tsx";
import { type ReactNode, useEffect, useState } from "react";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { useConsoleAccess } from "@/src/hooks/useConsoleAccess.ts";
import { useCreditsWallet } from "@/src/hooks/useCreditsWallet.ts";
import {
	useFeatureFlag,
	useFeatureFlagState,
} from "@/src/hooks/useFeatureFlag.ts";
import { useInterfaceStore } from "@/src/interfaces/interface-store.ts";
import { setInterfaceLevel } from "@/src/lib/interface-level.ts";
import { isRyuBot } from "@/src/lib/product.ts";
import {
	setProductMode,
	useProductMode,
	useProductModeStore,
} from "@/src/lib/product-mode.ts";
import { useNodeStore } from "@/src/store/useNodeStore.ts";

/** Syncs the server-backed Console gate and the existing surface preferences. */
export function ProductModeAccessSync({ children }: { children: ReactNode }) {
	const activeNode = useActiveNode();
	const { canSwitchToConsole, consoleOnly } = useConsoleAccess(activeNode);
	const cloudNodes = useNodeStore((state) => state.cloudNodes);
	const hydrateCloudNodes = useNodeStore((state) => state.hydrateCloudNodes);
	const { entitlement, loading: entitlementLoading } = useCreditsWallet();
	const productMode = useProductMode();
	const requestedProductMode = useProductModeStore(
		(state) => state.requestedMode
	);
	const setConsoleAccess = useProductModeStore(
		(state) => state.setConsoleAccess
	);
	// Rollout flags: OS, then the workspace interfaces beyond it. Both default
	// off, so Bot and Console are the only interfaces until they are switched on.
	const { enabled: osRolledOut, settled: osFlagSettled } =
		useFeatureFlagState(INTERFACE_OS_FLAG);
	const workspaceInterfacesRolledOut = useFeatureFlag(
		WORKSPACE_INTERFACES_FLAG
	);
	useEffect(() => {
		useProductModeStore.getState().setOsAccess(osRolledOut);
		useInterfaceStore
			.getState()
			.setWorkspaceInterfaces(workspaceInterfacesRolledOut);
	}, [osRolledOut, workspaceInterfacesRolledOut]);
	const [cloudNodesSettled, setCloudNodesSettled] = useState(false);
	// Whether the access effect below has decided Console access for this
	// launch. Until then the effective product mode is the gated fallback (a
	// remembered Console or OS choice reads as Bot), not the user's surface.
	const [accessResolved, setAccessResolved] = useState(false);

	useEffect(() => {
		hydrateCloudNodes()
			.catch(() => undefined)
			.finally(() => setCloudNodesSettled(true));
	}, [hydrateCloudNodes]);

	useEffect(() => {
		if (entitlementLoading || !cloudNodesSettled) {
			return;
		}
		if (isRyuBot()) {
			setConsoleAccess(false);
			setAccessResolved(true);
			return;
		}
		const managedProductAvailable =
			activeNode.managed === true ||
			cloudNodes.some((node) => node.managed) ||
			entitlement?.managedInference === true;
		if (
			!managedProductAvailable &&
			consoleOnly &&
			!(requestedProductMode === "os" && osRolledOut)
		) {
			// A remembered OS choice is only replaced once the OS flag has an
			// authoritative answer: on a cold start its compiled-in `false` would
			// otherwise persist Console before the server could say `true`.
			if (requestedProductMode === "os" && !osFlagSettled) {
				return;
			}
			setConsoleAccess(true);
			if (productMode !== "console") {
				setProductMode("console");
			}
			setAccessResolved(true);
			return;
		}
		setConsoleAccess(canSwitchToConsole);
		setAccessResolved(true);
	}, [
		activeNode.managed,
		canSwitchToConsole,
		cloudNodes,
		cloudNodesSettled,
		consoleOnly,
		entitlement?.managedInference,
		entitlementLoading,
		osFlagSettled,
		osRolledOut,
		productMode,
		requestedProductMode,
		setConsoleAccess,
	]);

	// Apply the level only once access is decided. Before that a Console user's
	// mode transiently reads as Bot, and applying Ryu Work's level then would
	// reset their sidebar to the Agents view (and Bot terminology) on every
	// launch, before the Code level is applied back over it.
	useEffect(() => {
		if (!accessResolved) {
			return;
		}
		setInterfaceLevel(productMode === "bot" ? "simple" : "expert");
	}, [accessResolved, productMode]);

	// The splash holds only the first resolution. The wallet reloads on every
	// window focus and org switch (`useCreditsWallet`), and replacing the shell
	// on each of those would unmount every open tab: an app's unsaved draft, a
	// chat composer, a terminal. Once access has settled, a reload keeps the
	// shell and the effect above re-decides access when the new answer lands.
	const accessLoading = entitlementLoading || !cloudNodesSettled;
	const [startupSettled, setStartupSettled] = useState(false);
	useEffect(() => {
		if (!accessLoading) {
			setStartupSettled(true);
		}
	}, [accessLoading]);

	if (accessLoading && !startupSettled) {
		return (
			<div
				className="flex size-full items-center justify-center"
				data-tauri-drag-region
			>
				<OrbLogo size="56px" variant="shimmer" />
			</div>
		);
	}
	return children;
}
