import { useEffect, useRef } from "react";
import { listAccounts } from "@/lib/auth-client.ts";
import {
	readStartupSelectionPreferences,
	startupSelectionSteps,
} from "../lib/startup-selection.ts";
import { useNodeStore } from "../store/useNodeStore.ts";

/** Decides whether the account/node startup chooser is needed. */
export function useStartupSelection({
	authed,
	botProduct,
	nodesReady,
	setStartupSelectionStatus,
	vaultReady,
}: {
	authed: boolean;
	botProduct: boolean;
	nodesReady: boolean;
	setStartupSelectionStatus: (status: "loading" | "show" | "ready") => void;
	vaultReady: boolean;
}): void {
	const startupNodes = useNodeStore((s) => s.nodes);
	const startupAccounts = vaultReady ? listAccounts() : [];
	const startupPreferences = readStartupSelectionPreferences();
	const startupNodeNames = startupNodes.map((node) => node.name).join("\u001f");
	const startupAccountIds = startupAccounts
		.map((account) => account.userId)
		.join("\u001f");
	// The chooser is a startup decision. Once this signed-in session got past it,
	// a node list that changes later (cloud nodes hydrating, a node added during
	// onboarding) must not bring it back: that would swap out whatever is mounted
	// (onboarding included) and restart it when the chooser resolves.
	const resolved = useRef(false);

	useEffect(() => {
		if (!authed) {
			resolved.current = false;
			setStartupSelectionStatus("ready");
			return;
		}
		if (resolved.current) {
			return;
		}
		if (botProduct) {
			setStartupSelectionStatus("ready");
			return;
		}
		if (!(vaultReady && nodesReady)) {
			setStartupSelectionStatus("loading");
			return;
		}
		const steps = startupSelectionSteps({
			accounts: startupAccounts,
			defaultAccountId: startupPreferences.defaultAccountId,
			defaultNodeName: startupPreferences.defaultNodeName,
			mode: startupPreferences.mode,
			nodes: startupNodes,
		});
		const show = steps.account || steps.node;
		resolved.current = !show;
		setStartupSelectionStatus(show ? "show" : "ready");
	}, [
		authed,
		nodesReady,
		startupAccountIds,
		startupNodeNames,
		startupPreferences.defaultAccountId,
		startupPreferences.defaultNodeName,
		startupPreferences.mode,
		vaultReady,
		botProduct,
	]);
}
