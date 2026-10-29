import { useEffect, useState } from "react";
import { fetchNodeOnboardingState } from "@/src/lib/api/onboarding-profile.ts";
import { rememberNodeSetupComplete } from "../lib/desktop-onboarding-state.ts";
import type { Node } from "../store/useNodeStore.ts";

/** The active node's server-owned setup state. */
export function useNodeOnboardingState({
	activeNodeForOnboarding,
	authed,
	botProduct,
	nodesReady,
	startupSelectionStatus,
	vaultReady,
}: {
	activeNodeForOnboarding: Node;
	authed: boolean;
	botProduct: boolean;
	nodesReady: boolean;
	startupSelectionStatus: "loading" | "show" | "ready";
	vaultReady: boolean;
}) {
	const [nodeOnboardingState, setNodeOnboardingState] = useState<Awaited<
		ReturnType<typeof fetchNodeOnboardingState>
	> | null>(null);
	const [nodeOnboardingStateStatus, setNodeOnboardingStateStatus] = useState<
		"loading" | "ready"
	>("loading");
	const [nodeOnboardingStateAvailable, setNodeOnboardingStateAvailable] =
		useState(false);

	// Node setup is a server-owned gate. Read it only after the active node and
	// startup chooser have settled, so a new desktop can discover an incomplete
	// node even when its own localStorage says desktop onboarding is finished.
	// Older nodes that do not expose the endpoint remain compatible: a failed read
	// does not invent state and falls back to the existing desktop-only marker.
	useEffect(() => {
		if (!authed || botProduct || !(vaultReady && nodesReady)) {
			setNodeOnboardingStateStatus("ready");
			return;
		}
		if (startupSelectionStatus !== "ready") {
			setNodeOnboardingStateStatus("loading");
			return;
		}
		let cancelled = false;
		setNodeOnboardingStateStatus("loading");
		const node = activeNodeForOnboarding;
		fetchNodeOnboardingState({
			token: node.token ?? null,
			url: node.url,
			userJwt: node.userJwt ?? null,
		})
			.then((next) => {
				rememberNodeSetupComplete(
					node.url,
					next.completed === true || next.canConfigure === false
				);
				if (!cancelled) {
					setNodeOnboardingState(next);
					setNodeOnboardingStateAvailable(true);
				}
			})
			.catch(() => {
				if (!cancelled) {
					setNodeOnboardingState(null);
					setNodeOnboardingStateAvailable(false);
				}
			})
			.finally(() => {
				if (!cancelled) {
					setNodeOnboardingStateStatus("ready");
				}
			});
		return () => {
			cancelled = true;
		};
	}, [
		activeNodeForOnboarding,
		authed,
		botProduct,
		nodesReady,
		startupSelectionStatus,
		vaultReady,
	]);

	return {
		nodeOnboardingState,
		nodeOnboardingStateAvailable,
		nodeOnboardingStateStatus,
	};
}
