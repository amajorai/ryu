import { useCallback } from "react";
import { toTarget } from "@/src/lib/api/client.ts";
import { installAndLaunchIsland } from "@/src/lib/api/island.ts";
import { setFeatureEnabled, TOGGLEABLE_FEATURES } from "@/src/lib/features.ts";
import { ISLAND_ENABLED } from "@/src/lib/island-availability.ts";
import { isLocalNode, type Node } from "@/src/store/useNodeStore.ts";
import {
	loadOnboardingAgents,
	type OnboardingAgents,
} from "./OnboardingPage.agents.tsx";
import type { useOnboardingLocalProgress } from "./OnboardingPage.local-progress.ts";
import {
	refreshLocalNode,
	STAGE_AGENTS,
	waitForLocalStack,
} from "./OnboardingPage.local-stack.ts";
import type { useOnboardingNodeSetup } from "./OnboardingPage.node-setup.ts";
import type { useOnboardingPhase } from "./OnboardingPage.phase.ts";
import type { useOnboardingProfileFlow } from "./OnboardingPage.profile.ts";
import type { useOnboardingSetupState } from "./OnboardingPage.setup-state.ts";
import type { useOnboardingFlowState } from "./OnboardingPage.state.ts";

type OnboardingAgentsStepInput = Pick<
	ReturnType<typeof useOnboardingFlowState>,
	| "agentsNode"
	| "agentsRetrying"
	| "cancelledRef"
	| "setAgentsNode"
	| "setAgentsRetrying"
	| "setAgentsUnavailable"
	| "setFoundAgents"
	| "setSelected"
	| "setSuggestedAgents"
> &
	Pick<
		ReturnType<typeof useOnboardingSetupState>,
		"featureIndex" | "setFeatureIndex"
	> &
	Pick<ReturnType<typeof useOnboardingNodeSetup>, "goToFeatures"> &
	Pick<ReturnType<typeof useOnboardingProfileFlow>, "goToMic"> &
	Pick<ReturnType<typeof useOnboardingLocalProgress>, "localReport"> &
	Pick<ReturnType<typeof useOnboardingPhase>, "setPhase">;

/** The feature wizard, the agents step, and local agent detection. */
export function useOnboardingAgentsStep({
	agentsNode,
	agentsRetrying,
	cancelledRef,
	featureIndex,
	goToFeatures,
	goToMic,
	localReport,
	setAgentsNode,
	setAgentsRetrying,
	setAgentsUnavailable,
	setFeatureIndex,
	setFoundAgents,
	setPhase,
	setSelected,
	setSuggestedAgents,
}: OnboardingAgentsStepInput) {
	// Apply the choice for the feature on screen (a disabled feature hides its
	// sidebar section), then advance to the next feature or on to the mic step.
	// Reads `featureIndex` from the render closure, so it's always the live step.
	const applyFeatureChoice = (enabled: boolean) => {
		const feature = TOGGLEABLE_FEATURES[featureIndex];
		if (feature) {
			setFeatureEnabled(feature.key, enabled);
		}
		const next = featureIndex + 1;
		if (next >= TOGGLEABLE_FEATURES.length) {
			goToMic();
		} else {
			setFeatureIndex(next);
		}
	};
	// Use the built-in agent for first setup; additional agents remain available in Store.
	const showAgentsStep = useCallback((node: Node, result: OnboardingAgents) => {
		setAgentsNode(node);
		setAgentsUnavailable(!result.ok);
		setFoundAgents(result.found);
		setSuggestedAgents(result.suggested);
		// Pre-select the ones already found on the user's system.
		setSelected(new Set(result.found.map((a) => a.id)));
		// Offer to migrate an existing OpenClaw / Hermes / Muse / Dots / Mastra /
		// LangChain agent before the first project, so it can start from it.
		setPhase("migrate");
	}, []);
	// Resumed personalization hands off to the optional first project. New setups
	// keep the built-in agent and proceed to the node defaults.
	const continueToFirstProject = useCallback(() => {
		setPhase("first-project");
	}, []);
	const continueToAgents = useCallback(() => {
		goToFeatures([]);
	}, [goToFeatures]);
	// Re-run detection from the step itself, after the inline "couldn't check
	// what's already installed" notice. Re-resolves the local node first, so a
	// token Core minted since the first attempt is picked up.
	const handleRetryAgents = useCallback(() => {
		if (!agentsNode || agentsRetrying) {
			return;
		}
		setAgentsRetrying(true);
		(async () => {
			const node = isLocalNode(agentsNode)
				? await refreshLocalNode()
				: agentsNode;
			const result = await loadOnboardingAgents(toTarget(node));
			if (cancelledRef.current) {
				return;
			}
			setAgentsRetrying(false);
			setAgentsNode(node);
			setAgentsUnavailable(!result.ok);
			setFoundAgents(result.found);
			setSuggestedAgents(result.suggested);
			// Keep whatever the user already ticked; add the newly-detected ones.
			setSelected((prev) => {
				const next = new Set(prev);
				for (const a of result.found) {
					next.add(a.id);
				}
				return next;
			});
		})().catch(() => {
			if (!cancelledRef.current) {
				setAgentsRetrying(false);
			}
		});
	}, [agentsNode, agentsRetrying]);
	// The local (bring-your-own-keys) path: wait for the local stack, then detect
	// installable CLI agents and move to the interactive 'agents' step. It takes
	// no node argument any more: the caller's node object predates Core's first
	// boot (and therefore its minted token), so the node is resolved HERE, after
	// the boot, and again per leg.
	const beginLocalSetup = useCallback(async () => {
		setPhase("installing");
		const node = await refreshLocalNode();
		if (cancelledRef.current) {
			return;
		}
		// Best-effort: get the Island companion installed + launched during
		// onboarding so it's ready by first chat. Fire-and-forget (no `await`) and
		// non-fatal — it must never block or fail onboarding, and dev is a no-op.
		// Skipped entirely while the ISLAND_ENABLED release gate is off.
		if (ISLAND_ENABLED) {
			installAndLaunchIsland().catch(() => undefined);
		}
		await waitForLocalStack(node, () => cancelledRef.current, localReport);
		if (cancelledRef.current) {
			return;
		}

		localReport.status("Looking for agents on your system…", STAGE_AGENTS);
		// Re-resolve once more: `waitForLocalStack` can run for 45s, and on a first
		// run the token may only have appeared inside that window.
		const detectNode = await refreshLocalNode();
		const result = await loadOnboardingAgents(toTarget(detectNode));
		localReport.status(null);
		if (cancelledRef.current) {
			return;
		}
		showAgentsStep(detectNode, result);
	}, [localReport, showAgentsStep]);
	return {
		applyFeatureChoice,
		beginLocalSetup,
		continueToAgents,
		continueToFirstProject,
		handleRetryAgents,
		showAgentsStep,
	};
}
