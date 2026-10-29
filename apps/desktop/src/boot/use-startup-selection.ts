import { useEffect } from "react";
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

	useEffect(() => {
		if (!authed) {
			setStartupSelectionStatus("ready");
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
		setStartupSelectionStatus(steps.account || steps.node ? "show" : "ready");
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
