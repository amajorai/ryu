import { useEffect, useRef, useState } from "react";
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
	// The node URL whose setup state has been read at least once. A re-read for
	// the same node (a refreshed bearer, a rebuilt node list) must stay quiet:
	// flipping back to "loading" swaps the shell for the boot splash, which
	// unmounts and restarts the whole onboarding flow. On Windows that happened on
	// every window focus (each click on a drag region, every window move),
	// because the focus handler refreshes cloud-node tokens and rebuilds the
	// node objects.
	const settledUrl = useRef<string | null>(null);
	const nodeUrl = activeNodeForOnboarding.url;
	const nodeToken = activeNodeForOnboarding.token ?? null;
	const nodeUserJwt = activeNodeForOnboarding.userJwt ?? null;

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
		const quiet = settledUrl.current === nodeUrl;
		if (startupSelectionStatus !== "ready") {
			if (!quiet) {
				setNodeOnboardingStateStatus("loading");
			}
			return;
		}
		let cancelled = false;
		if (!quiet) {
			setNodeOnboardingStateStatus("loading");
		}
		fetchNodeOnboardingState({
			token: nodeToken,
			url: nodeUrl,
			userJwt: nodeUserJwt,
		})
			.then((next) => {
				rememberNodeSetupComplete(
					nodeUrl,
					next.completed === true || next.canConfigure === false
				);
				if (!cancelled) {
					setNodeOnboardingState(next);
					setNodeOnboardingStateAvailable(true);
				}
			})
			.catch(() => {
				// A failed quiet re-read keeps the last answer for this node rather
				// than dropping a known setup state over a transient error.
				if (!(cancelled || quiet)) {
					setNodeOnboardingState(null);
					setNodeOnboardingStateAvailable(false);
				}
			})
			.finally(() => {
				if (!cancelled) {
					settledUrl.current = nodeUrl;
					setNodeOnboardingStateStatus("ready");
				}
			});
		return () => {
			cancelled = true;
		};
	}, [
		authed,
		botProduct,
		nodeToken,
		nodeUrl,
		nodeUserJwt,
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
