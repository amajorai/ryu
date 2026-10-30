import { useCallback } from "react";
import type { NavigateOptions } from "react-router-dom";
import { sileo } from "sileo";
import { toTarget } from "@/src/lib/api/client.ts";
import { saveOnboardingSkillSelection } from "@/src/lib/api/onboarding-skills.ts";
import { ensureMicPermission } from "@/src/lib/audio/devices.ts";
import { readOsNotificationsChoice } from "@/src/lib/notifications/notification-preferences.ts";
import { ONBOARDING_CHAT_ROUTE_STATE } from "@/src/lib/onboarding-navigation.ts";
import { OnboardingProjectMissingError } from "@/src/lib/onboarding-project-persistence.ts";
import { isLocalNode } from "@/src/store/useNodeStore.ts";
import { PHASE_SUBTITLES, PHASE_TITLES } from "./OnboardingPage.copy.ts";
import {
	MIC_PROMPT_MAX_MS,
	refreshLocalNode,
	sleep,
} from "./OnboardingPage.local-stack.ts";
import type { useOnboardingNodeSetup } from "./OnboardingPage.node-setup.ts";
import type { useOnboardingPhase } from "./OnboardingPage.phase.ts";
import type { useOnboardingFlowState } from "./OnboardingPage.state.ts";

type OnboardingStepsInput = Pick<
	ReturnType<typeof useOnboardingFlowState>,
	| "cancelledRef"
	| "localChecking"
	| "loopLine"
	| "mode"
	| "onboardingSkills"
	| "selected"
	| "selectedSkillPackIds"
	| "setOnboardingSkills"
	| "setSelected"
	| "setSelectedSkillPackIds"
	| "setSkillsError"
	| "setSkillsSubmitting"
	| "setSubmitting"
	| "skillsLoading"
	| "skillsSubmitting"
	| "submitting"
> &
	Pick<
		ReturnType<typeof useOnboardingPhase>,
		| "coreStatus"
		| "getActiveNode"
		| "nodeOnboardingPending"
		| "phase"
		| "setPhase"
	> &
	Pick<
		ReturnType<typeof useOnboardingNodeSetup>,
		"finish" | "goToFeatures" | "loadOnboardingSkills"
	>;

/** Skills, mic, theme, safety, guidance, and finishing step handlers. */
export function useOnboardingSteps({
	cancelledRef,
	coreStatus,
	finish,
	getActiveNode,
	goToFeatures,
	loadOnboardingSkills,
	localChecking,
	loopLine,
	mode,
	nodeOnboardingPending,
	onboardingSkills,
	phase,
	selected,
	selectedSkillPackIds,
	setOnboardingSkills,
	setPhase,
	setSelected,
	setSelectedSkillPackIds,
	setSkillsError,
	setSkillsSubmitting,
	setSubmitting,
	skillsLoading,
	skillsSubmitting,
	submitting,
}: OnboardingStepsInput) {
	// When Ryu never comes up (App.tsx flips it to "stopped" after its startup
	// timeout) a local-path user would otherwise sit on a shimmering progress bar
	// with no way out, so we render a dedicated error state with a restart button.
	// Scoped to the LOCAL path: a user who picked the cloud or their own node has
	// no local Core by design, and "stopped" is the correct, expected state for
	// them — blocking them on it is what made the desktop unusable without an
	// install in the first place.
	// Not while the local pick is still working: `startLocalCore` may be several
	// minutes into downloading the binary, which is longer than App.tsx's startup
	// grace — reporting that as "Couldn't start Ryu" would replace a working
	// install with an error screen. A genuine failure there ends on `choose` with
	// the unreachable card instead.
	const coreFailed =
		coreStatus === "stopped" && mode === "local" && !localChecking;
	// On the auto-advancing phases the rotating copy IS the headline; everywhere
	// else the static title/subtitle pair carries the step. Every non-rotating
	// phase has a PHASE_TITLES entry, so the fallthrough is always defined.
	const subtitle = loopLine ? undefined : PHASE_SUBTITLES.get(phase);
	const title = loopLine ?? PHASE_TITLES.get(phase)!;
	// Restart the whole app so it re-attempts startup from scratch; fall back to a
	// plain reload if the Tauri process plugin isn't reachable.
	const handleRestart = useCallback(async () => {
		try {
			const { relaunch } = await import("@tauri-apps/plugin-process");
			await relaunch();
		} catch {
			window.location.reload();
		}
	}, []);
	const toggle = useCallback((id: string) => {
		setSelected((prev) => {
			const next = new Set(prev);
			if (next.has(id)) {
				next.delete(id);
			} else {
				next.add(id);
			}
			return next;
		});
	}, []);
	const toggleSkillPack = useCallback((id: string) => {
		setSelectedSkillPackIds((previous) => {
			const next = new Set(previous);
			if (next.has(id)) {
				next.delete(id);
			} else {
				next.add(id);
			}
			return next;
		});
	}, []);
	const selectAllSkillPacks = useCallback(() => {
		setSelectedSkillPackIds(
			new Set(onboardingSkills?.options.map((option) => option.id) ?? [])
		);
	}, [onboardingSkills]);
	const clearAllSkillPacks = useCallback(() => {
		setSelectedSkillPackIds(new Set());
	}, []);
	const retryOnboardingSkills = useCallback(() => {
		if (skillsLoading) {
			return;
		}
		const active = getActiveNode();
		const node = isLocalNode(active)
			? refreshLocalNode()
			: Promise.resolve(active);
		void node
			.then((resolved) => loadOnboardingSkills(toTarget(resolved)))
			.catch((error) => {
				setSkillsError(
					error instanceof Error
						? error.message
						: "Ryu couldn't reload the recommended skills. Try again."
				);
			});
	}, [getActiveNode, loadOnboardingSkills, skillsLoading]);
	const handleContinueSkills = useCallback(async () => {
		if (skillsSubmitting || skillsLoading) {
			return;
		}
		setSkillsSubmitting(true);
		setSkillsError(null);
		try {
			const active = getActiveNode();
			const node = isLocalNode(active) ? await refreshLocalNode() : active;
			const snapshot = await saveOnboardingSkillSelection(
				toTarget(node),
				Array.from(selectedSkillPackIds)
			);
			setOnboardingSkills(snapshot);
			setSelectedSkillPackIds(new Set(snapshot.selectedPackIds));
			if (snapshot.syncComplete === false) {
				setSkillsError(
					"Your choice was saved, but one or more selected packs could not be installed. Retry to finish setting up this node."
				);
				return;
			}
			setPhase("local-default");
		} catch (error) {
			setSkillsError(
				error instanceof Error
					? error.message
					: "Ryu couldn't save the recommended skill selection. Try again."
			);
		} finally {
			setSkillsSubmitting(false);
		}
	}, [getActiveNode, skillsLoading, skillsSubmitting, selectedSkillPackIds]);
	const handleContinue = useCallback(() => {
		goToFeatures(Array.from(selected));
	}, [goToFeatures, selected]);
	// The mic answer (either way) hands off to the look-and-feel step, so the user
	// lands in an app that already looks like theirs. Clearing `submitting` matters:
	// the mic step sets it while the OS prompt is up, and leaving it pinned would
	// render the theme step's Continue disabled.
	const goToTheme = useCallback(() => {
		setSubmitting(false);
		setPhase("theme");
	}, []);
	// Leave the mic step. Skip goes straight on; Allow requests mic access first
	// (non-blocking: a denial still completes onboarding).
	const handleSkipMic = useCallback(() => {
		if (submitting) {
			return;
		}
		goToTheme();
	}, [submitting, goToTheme]);
	const handleAllowMic = useCallback(async () => {
		if (submitting) {
			return;
		}
		setSubmitting(true);
		try {
			// `getUserMedia` only settles when the OS prompt is answered, so an
			// ignored (or focus-lost) TCC dialog leaves it pending forever. With both
			// mic buttons disabled while `submitting`, that used to be a dead end;
			// race it so onboarding always moves on. The grant still lands if the
			// user answers later — we just stop waiting for them.
			await Promise.race([ensureMicPermission(), sleep(MIC_PROMPT_MAX_MS)]);
		} catch {
			// Permission prompt denied or unavailable — still continue onboarding.
		}
		if (cancelledRef.current) {
			return;
		}
		goToTheme();
	}, [submitting, goToTheme]);
	// The theme step already persisted every pick as it was made, so Continue
	// hands off to the node-wide safety posture step.
	const goToSafety = useCallback(() => {
		if (submitting) {
			return;
		}
		setSubmitting(false);
		setPhase(nodeOnboardingPending ? "safety" : "preferences");
	}, [nodeOnboardingPending, submitting]);
	// Keep safety and privacy disclosures in setup; preferences can be changed in Settings.
	const goToPreferences = useCallback(() => {
		if (submitting) {
			return;
		}
		setSubmitting(false);
		setPhase("guidance");
	}, [submitting]);
	// Preferences persist as they change, then onboarding gives agent guidance
	// its own screen before showing privacy choices.
	const goToGuidanceStep = useCallback(() => {
		if (submitting) {
			return;
		}
		setSubmitting(false);
		setPhase("guidance");
	}, [submitting]);
	const goToPrivacyStep = useCallback(() => {
		setPhase("privacy");
	}, []);
	// Guidance hands off to the notifications step: asking here, from a click and
	// with copy for the platform the shell runs on, is the only prompt the user
	// sees; the notification paths themselves never prompt mid-session. A user
	// who already chose (e.g. in Settings, or on a resumed setup) skips it.
	const goToNotificationsStep = useCallback(() => {
		setPhase(
			readOsNotificationsChoice() === null ? "notifications" : "privacy"
		);
	}, []);
	const finishOnboarding = useCallback(
		(routeState: NavigateOptions["state"] = ONBOARDING_CHAT_ROUTE_STATE) => {
			if (submitting) {
				return;
			}
			setSubmitting(true);
			(async () => {
				// Re-resolve the local node one last time: this is the call that actually
				// ADDS the agents the user picked, and a tokenless target would 401 every
				// one of them into Promise.allSettled's silent rejected bucket.
				const active = getActiveNode();
				const node = isLocalNode(active) ? await refreshLocalNode() : active;
				await finish(toTarget(node), routeState);
			})().catch((error) => {
				setSubmitting(false);
				if (error instanceof OnboardingProjectMissingError) {
					setPhase("first-project");
				}
				sileo.error({
					title: "Onboarding could not be completed",
					description:
						error instanceof Error
							? error.message
							: "Try again from this step.",
				});
			});
		},
		[submitting, getActiveNode, finish]
	);
	return {
		clearAllSkillPacks,
		coreFailed,
		finishOnboarding,
		goToGuidanceStep,
		goToNotificationsStep,
		goToPreferences,
		goToPrivacyStep,
		goToSafety,
		handleAllowMic,
		handleContinue,
		handleContinueSkills,
		handleRestart,
		handleSkipMic,
		retryOnboardingSkills,
		selectAllSkillPacks,
		subtitle,
		title,
		toggle,
		toggleSkillPack,
	};
}
