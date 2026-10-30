import { useCallback, useEffect } from "react";
import type { NavigateOptions } from "react-router-dom";
import { sileo } from "sileo";
import { z } from "zod";
import { getActiveUserId } from "@/lib/auth-client.ts";
import { track } from "@/src/lib/analytics.ts";
import { installAgent } from "@/src/lib/api/agents.ts";
import { type ApiTarget, toTarget } from "@/src/lib/api/client.ts";
import {
	type SaveNodeOnboardingStateInput,
	saveNodeOnboardingState,
} from "@/src/lib/api/onboarding-profile.ts";
import { fetchOnboardingSkills } from "@/src/lib/api/onboarding-skills.ts";
import {
	defaultLocalAgentSelection,
	EMPTY_AGENT_SELECTION,
	getLaneAgentSelection,
	setPreference,
	USER_PERSONALIZATION_PREF_KEY,
	type UserPersonalization,
} from "@/src/lib/api/preferences.ts";
import { triggerAgentsRefresh } from "@/src/lib/core-refresh.ts";
import { markDesktopOnboardingComplete } from "@/src/lib/desktop-onboarding-state.ts";
import {
	ONBOARDING_CHAT_ROUTE_STATE,
	withOnboardingProject,
} from "@/src/lib/onboarding-navigation.ts";
import {
	bindOnboardingProjectTarget,
	clearOnboardingProjectPointer,
	restoreOnboardingProject,
	sameOnboardingProjectBinding,
} from "@/src/lib/onboarding-project-persistence.ts";
import { isLocalNode } from "@/src/store/useNodeStore.ts";
import { refreshLocalNode, sleep } from "./OnboardingPage.local-stack.ts";
import type { useOnboardingPhase } from "./OnboardingPage.phase.ts";
import type { useOnboardingFlowState } from "./OnboardingPage.state.ts";

type OnboardingNodeSetupInput = Pick<
	ReturnType<typeof useOnboardingFlowState>,
	| "companyContext"
	| "companyKnowledgeEnabled"
	| "nodeSetupKind"
	| "onboardingSkills"
	| "setAllowedAgentIds"
	| "setCloudSelection"
	| "setCompanyContext"
	| "setCompanyKnowledgeEnabled"
	| "setLocalSelection"
	| "setNodeSetupError"
	| "setNodeSetupKind"
	| "setOnboardingSkills"
	| "setSelectedSkillPackIds"
	| "setSkillsError"
	| "setSkillsLoading"
	| "setSubmitting"
	| "setUserPersonalization"
	| "skillsError"
	| "skillsLoadStartedRef"
	| "submitting"
> &
	Pick<
		ReturnType<typeof useOnboardingPhase>,
		| "getActiveNode"
		| "navigate"
		| "nodeOnboardingPending"
		| "phase"
		| "setNodeOnboardingState"
		| "setPhase"
	>;

/** Finishing onboarding, recommended skills, and node setup. */
export function useOnboardingNodeSetup({
	companyContext,
	companyKnowledgeEnabled,
	getActiveNode,
	navigate,
	nodeOnboardingPending,
	nodeSetupKind,
	onboardingSkills,
	phase,
	setAllowedAgentIds,
	setCloudSelection,
	setCompanyContext,
	setCompanyKnowledgeEnabled,
	setLocalSelection,
	setNodeOnboardingState,
	setNodeSetupError,
	setNodeSetupKind,
	setOnboardingSkills,
	setPhase,
	setSelectedSkillPackIds,
	setSkillsError,
	setSkillsLoading,
	setSubmitting,
	setUserPersonalization,
	skillsError,
	skillsLoadStartedRef,
	submitting,
}: OnboardingNodeSetupInput) {
	const finish = useCallback(
		async (
			target: ApiTarget,
			routeState: NavigateOptions["state"] = ONBOARDING_CHAT_ROUTE_STATE
		) => {
			const binding = await bindOnboardingProjectTarget(
				target,
				getActiveUserId()
			);
			const projectSeed = await restoreOnboardingProject(target, binding);
			const currentBinding = await bindOnboardingProjectTarget(
				toTarget(getActiveNode()),
				getActiveUserId()
			);
			if (!sameOnboardingProjectBinding(binding, currentBinding)) {
				throw new Error(
					"The active node or account changed. Retry setup on the project owner's node and account."
				);
			}
			if (nodeOnboardingPending) {
				if (!nodeSetupKind) {
					setPhase("node-setup");
					throw new Error(
						"Choose personal or team use before finishing setup."
					);
				}
				const saved = await saveNodeOnboardingState(target, {
					companyContext,
					companyKnowledgeEnabled,
					completed: true,
					setupKind: nodeSetupKind,
				});
				setNodeOnboardingState(saved);
			}
			setPhase("finishing");
			// Memory is enabled before the profile turn and long-term recall is on for
			// the first chat. Existing explicit disables are respected by Core's app
			// seeder; this only opts a fresh onboarding flow into its first build.
			localStorage.setItem("ryu_long_term_memory", "true");

			localStorage.setItem("ryu_default_agent", "ryu");

			await sleep(900);
			setPhase("done");
			await sleep(500);
			const finalBinding = await bindOnboardingProjectTarget(
				toTarget(getActiveNode()),
				getActiveUserId()
			);
			if (!sameOnboardingProjectBinding(binding, finalBinding)) {
				setPhase(phase);
				throw new Error(
					"The active node or account changed. Retry setup on the project owner's node and account."
				);
			}
			try {
				clearOnboardingProjectPointer();
			} catch (error) {
				setPhase(phase);
				throw error;
			}
			markDesktopOnboardingComplete();
			track({ event: "onboarding_completed" });
			const parsedRouteState = z
				.preprocess(
					(value) => (Array.isArray(value) ? { ...value } : value),
					z.looseObject({})
				)
				.safeParse(routeState);
			navigate("/chat", {
				replace: true,
				state: parsedRouteState.success
					? withOnboardingProject(parsedRouteState.data, projectSeed)
					: routeState,
			});
		},
		[
			getActiveNode,
			companyContext,
			companyKnowledgeEnabled,
			navigate,
			nodeOnboardingPending,
			nodeSetupKind,
			phase,
		]
	);
	const finishNodeOnly = useCallback(() => {
		if (submitting) {
			return;
		}
		setSubmitting(true);
		const active = getActiveNode();
		const node = isLocalNode(active)
			? refreshLocalNode()
			: Promise.resolve(active);
		void node
			.then((resolved) => finish(toTarget(resolved)))
			.catch((error) => {
				setSubmitting(false);
				sileo.error({
					title: "Node setup could not be completed",
					description:
						error instanceof Error
							? error.message
							: "Try again from this step.",
				});
			});
	}, [finish, getActiveNode, submitting]);
	const loadOnboardingSkills = useCallback(async (target: ApiTarget) => {
		setSkillsLoading(true);
		setSkillsError(null);
		try {
			const snapshot = await fetchOnboardingSkills(target);
			setOnboardingSkills(snapshot);
			setSelectedSkillPackIds(new Set(snapshot.selectedPackIds));
		} catch (error) {
			setSkillsError(
				error instanceof Error
					? error.message
					: "Ryu couldn't load the recommended skills. Try again."
			);
		} finally {
			setSkillsLoading(false);
		}
	}, []);
	useEffect(() => {
		if (
			phase !== "skills" ||
			onboardingSkills ||
			skillsError ||
			skillsLoadStartedRef.current
		) {
			return;
		}
		skillsLoadStartedRef.current = true;
		let cancelled = false;
		void (async () => {
			try {
				const active = getActiveNode();
				const node = isLocalNode(active) ? await refreshLocalNode() : active;
				if (!cancelled) {
					await loadOnboardingSkills(toTarget(node));
				}
			} catch (error) {
				if (cancelled) {
					return;
				}
				setSkillsError(
					error instanceof Error
						? error.message
						: "Ryu couldn't load the recommended skills. Try again."
				);
				setSkillsLoading(false);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [
		getActiveNode,
		loadOnboardingSkills,
		onboardingSkills,
		phase,
		refreshLocalNode,
		skillsError,
	]);
	const handleNodeSetupContinue = useCallback(
		async (
			input: SaveNodeOnboardingStateInput & {
				personalization: UserPersonalization;
			}
		) => {
			if (submitting) {
				return;
			}
			setSubmitting(true);
			setNodeSetupError(null);
			try {
				const target = toTarget(getActiveNode());
				const saved = await saveNodeOnboardingState(target, {
					companyContext: input.companyContext,
					companyKnowledgeEnabled: input.companyKnowledgeEnabled,
					completed: false,
					setupKind: input.setupKind,
				});
				if (input.setupKind === "personal") {
					await setPreference(
						target,
						USER_PERSONALIZATION_PREF_KEY,
						JSON.stringify(input.personalization)
					);
				}
				const [local, cloud] = await Promise.all([
					getLaneAgentSelection(target, "local").catch(() =>
						defaultLocalAgentSelection()
					),
					getLaneAgentSelection(target, "cloud").catch(
						() => EMPTY_AGENT_SELECTION
					),
				]);
				setNodeOnboardingState(saved);
				setNodeSetupKind(input.setupKind);
				setCompanyContext(saved.personalization.companyContext);
				setCompanyKnowledgeEnabled(
					saved.personalization.companyKnowledgeEnabled
				);
				setUserPersonalization(input.personalization);
				setLocalSelection(
					local.agent_id || local.model ? local : defaultLocalAgentSelection()
				);
				setCloudSelection(cloud);
				setPhase("local-default");
			} catch (error) {
				setNodeSetupError(
					error instanceof Error
						? error.message
						: "Ryu couldn't save this node setup. Try again."
				);
			} finally {
				setSubmitting(false);
			}
		},
		[getActiveNode, submitting]
	);
	// Install the user's Add Agents choices before the lane pickers render. This
	// keeps the picker scope honest: onboarding can only offer Ryu plus the agents
	// the user just selected, while the rest of the app remains unconstrained.
	const goToFeatures = useCallback(
		(installIds: string[]) => {
			setAllowedAgentIds(["ryu", ...installIds.filter((id) => id !== "ryu")]);
			setSubmitting(true);
			setPhase("installing");
			void (async () => {
				const active = getActiveNode();
				const node = isLocalNode(active) ? await refreshLocalNode() : active;
				const target = toTarget(node);
				await Promise.allSettled(
					installIds.map((id) => installAgent(target, id))
				);
				triggerAgentsRefresh();
				const [local, cloud] = await Promise.all([
					getLaneAgentSelection(target, "local"),
					getLaneAgentSelection(target, "cloud"),
				]);
				setLocalSelection(
					local.agent_id || local.model ? local : defaultLocalAgentSelection()
				);
				setCloudSelection(cloud);
				setSubmitting(false);
				setPhase(nodeOnboardingPending ? "node-setup" : "local-default");
			})().catch(() => {
				setSubmitting(false);
				setPhase(nodeOnboardingPending ? "node-setup" : "local-default");
			});
		},
		[getActiveNode, nodeOnboardingPending]
	);
	return {
		finish,
		finishNodeOnly,
		goToFeatures,
		handleNodeSetupContinue,
		loadOnboardingSkills,
	};
}
