import { isNativeFunction } from "@ryu/ui/lib/native-primitive-observation.ts";
import {
	type SetStateAction,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import { useNavigate } from "react-router-dom";
import { useShallow } from "zustand/react/shallow";
import { useRyuOnboardingPersona } from "@/src/components/onboarding/RyuOnboardingPersona.tsx";
import { useStepUp } from "@/src/components/StepUpDialog.tsx";
import { useAppSurface } from "@/src/contexts/app-surface-context.tsx";
import { useCreditsWallet } from "@/src/hooks/useCreditsWallet.ts";
import {
	isDesktopOnboardingComplete,
	persistDesktopOnboardingPhase,
	resolveDesktopOnboardingPhase,
} from "@/src/lib/desktop-onboarding-state.ts";
import { useEntityCap } from "@/src/lib/gating/useEntityCap.ts";
import { useAppStore } from "@/src/store/useAppStore.ts";
import { useNodeStore } from "@/src/store/useNodeStore.ts";
import type { OnboardingPageProps, Phase } from "./OnboardingPage.copy.ts";

interface OnboardingPhaseInput {
	initialNodeOnboardingState: OnboardingPageProps["nodeOnboardingState"];
	nodeOnboardingStateAvailable: OnboardingPageProps["nodeOnboardingStateAvailable"];
}

/** App context, node onboarding state, and the persisted wizard phase. */
export function useOnboardingPhase({
	initialNodeOnboardingState,
	nodeOnboardingStateAvailable,
}: OnboardingPhaseInput) {
	const onboardingPersona = useRyuOnboardingPersona();
	const { isDesktop } = useAppSurface();
	const navigate = useNavigate();
	const stepUp = useStepUp();
	const coreStatus = useAppStore((s) => s.coreStatus);
	const { getActiveNode, hydrateCloudNodes, setDefault, updateNodeToken } =
		useNodeStore(
			useShallow((s) => ({
				getActiveNode: s.getActiveNode,
				hydrateCloudNodes: s.hydrateCloudNodes,
				setDefault: s.setDefault,
				updateNodeToken: s.updateNodeToken,
			}))
		);
	// The exact entitlement read NodeSelector's managed surfaces use (WS8): gates
	// the managed (Ryu Cloud) option on the plan's managed-inference flag.
	const {
		entitlement,
		loading: entitlementLoading,
		refresh: refreshCredits,
	} = useCreditsWallet();
	const { guard: guardAgentCreation } = useEntityCap();
	const desktopOnboardingPending = !isDesktopOnboardingComplete();
	const [nodeOnboardingState, setNodeOnboardingState] = useState(
		initialNodeOnboardingState
	);
	const nodeOnboardingPending =
		nodeOnboardingStateAvailable &&
		nodeOnboardingState?.canConfigure !== false &&
		nodeOnboardingState?.completed !== true;
	// A fresh flow opens on the welcome intro after device auth succeeds. The
	// browser builds reuse this page, but a browser deployment is not a desktop
	// bundle and must not present a native-app update verdict, so the intro hands
	// off to the update check only in Tauri.
	const [phase, setPhaseState] = useState<Phase>(() =>
		resolveDesktopOnboardingPhase({
			desktopPending: desktopOnboardingPending,
			nodePending: nodeOnboardingPending,
		})
	);
	const phaseRef = useRef(phase);
	const setPhase = useCallback((next: SetStateAction<Phase>) => {
		const nextPhase = isNativeFunction(next) ? next(phaseRef.current) : next;
		phaseRef.current = nextPhase;
		persistDesktopOnboardingPhase(nextPhase);
		setPhaseState(nextPhase);
	}, []);
	useEffect(() => {
		persistDesktopOnboardingPhase(phase);
	}, [phase]);
	return {
		coreStatus,
		desktopOnboardingPending,
		entitlement,
		entitlementLoading,
		getActiveNode,
		guardAgentCreation,
		hydrateCloudNodes,
		isDesktop,
		navigate,
		nodeOnboardingPending,
		nodeOnboardingState,
		onboardingPersona,
		phase,
		phaseRef,
		refreshCredits,
		setDefault,
		setNodeOnboardingState,
		setPhase,
		stepUp,
		updateNodeToken,
	};
}
