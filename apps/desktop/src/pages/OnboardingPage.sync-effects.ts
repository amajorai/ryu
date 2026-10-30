import { useEffect } from "react";
import { z } from "zod";
import { toTarget } from "@/src/lib/api/client.ts";
import {
	defaultLocalAgentSelection,
	EMPTY_AGENT_SELECTION,
	getLaneAgentSelection,
	getPreference,
	isAgentSelectionEmpty,
	USER_PERSONALIZATION_PREF_KEY,
} from "@/src/lib/api/preferences.ts";
import {
	type InstallerProgress,
	installerComponentLabel,
} from "@/src/lib/installer-progress.ts";
import { listenWhenReady } from "@/src/lib/tauri-ready.ts";
import type { OnboardingPageProps } from "./OnboardingPage.copy.ts";
import type { useOnboardingLocalProgress } from "./OnboardingPage.local-progress.ts";
import type { useOnboardingPhase } from "./OnboardingPage.phase.ts";
import type { useOnboardingFlowState } from "./OnboardingPage.state.ts";

type OnboardingSyncEffectsInput = Pick<
	ReturnType<typeof useOnboardingPhase>,
	| "getActiveNode"
	| "nodeOnboardingPending"
	| "phaseRef"
	| "setNodeOnboardingState"
> &
	Pick<
		ReturnType<typeof useOnboardingFlowState>,
		| "lastExternalNodeState"
		| "liveStatusRef"
		| "setCloudSelection"
		| "setCompanyContext"
		| "setCompanyKnowledgeEnabled"
		| "setLocalSelection"
		| "setNodeSetupError"
		| "setNodeSetupKind"
		| "setSubmitting"
		| "setUserPersonalization"
	> &
	Pick<
		ReturnType<typeof useOnboardingLocalProgress>,
		"reportDone" | "updateLocalPercent"
	> & {
		initialNodeOnboardingState: OnboardingPageProps["nodeOnboardingState"];
		nodeOnboardingStateAvailable: OnboardingPageProps["nodeOnboardingStateAvailable"];
	};

/** Effects that preload saved choices and mirror installer progress. */
export function useOnboardingSyncEffects({
	getActiveNode,
	initialNodeOnboardingState,
	lastExternalNodeState,
	liveStatusRef,
	nodeOnboardingPending,
	nodeOnboardingStateAvailable,
	phaseRef,
	reportDone,
	setCloudSelection,
	setCompanyContext,
	setCompanyKnowledgeEnabled,
	setLocalSelection,
	setNodeOnboardingState,
	setNodeSetupError,
	setNodeSetupKind,
	setSubmitting,
	setUserPersonalization,
	updateLocalPercent,
}: OnboardingSyncEffectsInput) {
	// Preserve a previously entered personal profile when node onboarding is
	// resumed. This preference is only written for the personal-node path; team
	// context stays in the node state and is visible to everyone on that node.
	useEffect(() => {
		if (!(nodeOnboardingStateAvailable && nodeOnboardingPending)) {
			return;
		}
		let cancelled = false;
		void getPreference(toTarget(getActiveNode()), USER_PERSONALIZATION_PREF_KEY)
			.then((raw) => {
				if (cancelled || !raw) {
					return;
				}
				try {
					const parsed = z
						.object({
							aboutOrganization: z.string().optional(),
							aboutYou: z.string().optional(),
							nickname: z.string().optional(),
							occupation: z.string().optional(),
						})
						.parse(JSON.parse(raw));
					setUserPersonalization((current) => ({
						...current,
						...parsed,
					}));
				} catch {
					// Keep the empty defaults when an older client left corrupt data.
				}
			})
			.catch(() => undefined);
		return () => {
			cancelled = true;
		};
	}, [getActiveNode, nodeOnboardingPending, nodeOnboardingStateAvailable]);
	// Mirror the public installer's versioned progress envelope. The stream covers
	// Core, Gateway, CLI, Core boot, and the bundled defaults; agent detection and
	// the rest of Desktop onboarding remain local responsibilities.
	useEffect(() => {
		const unlisteners: (() => void)[] = [];
		listenWhenReady<InstallerProgress>("installer-progress", ({ payload }) => {
			const percent = payload.percent ?? null;
			if (payload.phase === "binary") {
				const label = installerComponentLabel(payload.component);
				if (payload.status === "started") {
					liveStatusRef.current = `Installing ${label}…`;
				} else if (
					payload.status === "complete" ||
					payload.status === "skipped"
				) {
					reportDone(`${label} installed`);
					liveStatusRef.current = null;
				}
				updateLocalPercent(percent);
			} else if (payload.phase === "core") {
				if (payload.status === "started") {
					liveStatusRef.current = "Starting Ryu Core…";
				} else if (payload.status === "complete") {
					reportDone("Ryu Core is healthy");
					liveStatusRef.current = null;
				}
				updateLocalPercent(percent);
			} else if (payload.phase === "defaults") {
				if (
					payload.component === "bundled-defaults" &&
					payload.status === "started"
				) {
					liveStatusRef.current =
						"Installing bundled models, engines, and skills…";
				} else if (
					payload.component === "bundled-defaults" &&
					payload.status === "skipped"
				) {
					liveStatusRef.current = null;
				}
				updateLocalPercent(percent);
			} else if (payload.phase === "bootstrap") {
				// `startLocalCore` still performs the Desktop health wait after the
				// script exits, so leave room for that phase before the local-stack
				// and agent steps take the bar to completion.
				updateLocalPercent(payload.status === "complete" ? 75 : percent);
			} else if (payload.phase === "error") {
				liveStatusRef.current = null;
			}
		}).then((fn) => unlisteners.push(fn));
		return () => {
			for (const fn of unlisteners) {
				fn();
			}
		};
	}, [reportDone, updateLocalPercent]);
	useEffect(() => {
		if (lastExternalNodeState.current === initialNodeOnboardingState) {
			return;
		}
		lastExternalNodeState.current = initialNodeOnboardingState;
		setNodeOnboardingState(initialNodeOnboardingState);
		setNodeSetupKind(initialNodeOnboardingState?.setupKind ?? null);
		setCompanyContext(
			initialNodeOnboardingState?.personalization.companyContext ?? ""
		);
		setCompanyKnowledgeEnabled(
			initialNodeOnboardingState?.setupKind === "team"
				? initialNodeOnboardingState.personalization.companyKnowledgeEnabled
				: true
		);
		setNodeSetupError(null);
	}, [initialNodeOnboardingState]);
	// The lane selections are normally read from the node on the way into the
	// lane-default steps. A setup resumed directly on one of those steps skips
	// that read, and saving the empty selection would clear the node's stored
	// default, so read it here and hold Save until it lands.
	useEffect(() => {
		const resumedPhase = phaseRef.current;
		if (resumedPhase !== "local-default" && resumedPhase !== "cloud-default") {
			return;
		}
		let cancelled = false;
		setSubmitting(true);
		const target = toTarget(getActiveNode());
		Promise.all([
			getLaneAgentSelection(target, "local").catch(() => EMPTY_AGENT_SELECTION),
			getLaneAgentSelection(target, "cloud").catch(() => EMPTY_AGENT_SELECTION),
		])
			.then(([local, cloud]) => {
				if (cancelled) {
					return;
				}
				setLocalSelection((current) =>
					isAgentSelectionEmpty(current)
						? local.agent_id || local.model
							? local
							: defaultLocalAgentSelection()
						: current
				);
				setCloudSelection((current) =>
					isAgentSelectionEmpty(current) ? cloud : current
				);
			})
			.finally(() => {
				if (!cancelled) {
					setSubmitting(false);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [getActiveNode]);
	return {};
}
