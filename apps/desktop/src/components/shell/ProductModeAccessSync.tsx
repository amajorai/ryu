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
			return;
		}
		setConsoleAccess(canSwitchToConsole);
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

	useEffect(() => {
		setInterfaceLevel(productMode === "bot" ? "simple" : "expert");
	}, [productMode]);

	if (entitlementLoading || !cloudNodesSettled) {
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
