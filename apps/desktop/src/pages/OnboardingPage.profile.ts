import { useLiteralMessages } from "@ryu/i18n/react";
import { useCallback, useEffect, useRef } from "react";
import { sileo } from "sileo";
import { AGENT_IDENTITY_MODE_OPTIONS } from "@/src/components/agents/AgentIdentityModePicker.tsx";
import {
	buildSuggestedAgentInput,
	SUGGESTED_AGENT_ENGINE,
	suggestionIdentityMode,
} from "@/src/lib/agent-suggestion.ts";
import { importAgentThread } from "@/src/lib/api/agent-threads.ts";
import {
	type AgentIdentityMode,
	checkAgentLaunch,
	createAgent,
	fetchAgents,
} from "@/src/lib/api/agents.ts";
import { toTarget } from "@/src/lib/api/client.ts";
import {
	cancelProfileJob,
	continueProfileJobInBackground,
	getProfileJobStatus,
	type OnboardingAgentSuggestion,
	startProfileJob,
} from "@/src/lib/api/onboarding-profile.ts";
import {
	EMPTY_AGENT_SELECTION,
	setLaneAgentSelection,
} from "@/src/lib/api/preferences.ts";
import { triggerAgentsRefresh } from "@/src/lib/core-refresh.ts";
import { agentSuggestionsFailureMessage } from "./OnboardingPage.copy.ts";
import type { useOnboardingNodeSetup } from "./OnboardingPage.node-setup.ts";
import type { useOnboardingPhase } from "./OnboardingPage.phase.ts";
import type { useOnboardingSetupState } from "./OnboardingPage.setup-state.ts";
import type { useOnboardingFlowState } from "./OnboardingPage.state.ts";
import type { useOnboardingWorkspace } from "./OnboardingPage.workspace.ts";

type OnboardingProfileFlowInput = Pick<
	ReturnType<typeof useOnboardingSetupState>,
	| "agentSuggestionIdentityModes"
	| "agentSuggestions"
	| "agentSuggestionsSubmitting"
	| "connections"
	| "entitlementStateRef"
	| "gatewaySetupAllowed"
	| "importedConversationIds"
	| "importing"
	| "organizations"
	| "profileJob"
	| "reviewedAgentSuggestions"
	| "selectedAgentSuggestions"
	| "selectedOrganizationId"
	| "setAgentSuggestionIdentityModes"
	| "setAgentSuggestions"
	| "setAgentSuggestionsError"
	| "setAgentSuggestionsSubmitting"
	| "setImportedConversationIds"
	| "setImporting"
	| "setProfileJob"
	| "setProfileStartedAt"
	| "setReviewedAgentSuggestions"
	| "setSelectedAgentSuggestions"
	| "threadGroups"
> &
	Pick<
		ReturnType<typeof useOnboardingFlowState>,
		| "cloudSelection"
		| "companyKnowledgeEnabled"
		| "nodeSetupKind"
		| "setCloudSelection"
		| "setSubmitting"
		| "submitting"
	> &
	Pick<
		ReturnType<typeof useOnboardingPhase>,
		| "desktopOnboardingPending"
		| "getActiveNode"
		| "guardAgentCreation"
		| "nodeOnboardingPending"
		| "phase"
		| "setPhase"
	> &
	Pick<ReturnType<typeof useOnboardingNodeSetup>, "finishNodeOnly"> &
	Pick<ReturnType<typeof useOnboardingWorkspace>, "scanOnboardingThreads">;

/** Thread imports, the workspace profile, and suggested agents. */
export function useOnboardingProfileFlow({
	agentSuggestionIdentityModes,
	agentSuggestions,
	agentSuggestionsSubmitting,
	cloudSelection,
	companyKnowledgeEnabled,
	connections,
	desktopOnboardingPending,
	entitlementStateRef,
	finishNodeOnly,
	gatewaySetupAllowed,
	getActiveNode,
	guardAgentCreation,
	importedConversationIds,
	importing,
	nodeOnboardingPending,
	nodeSetupKind,
	organizations,
	phase,
	profileJob,
	reviewedAgentSuggestions,
	scanOnboardingThreads,
	selectedAgentSuggestions,
	selectedOrganizationId,
	setAgentSuggestionIdentityModes,
	setAgentSuggestions,
	setAgentSuggestionsError,
	setAgentSuggestionsSubmitting,
	setCloudSelection,
	setImportedConversationIds,
	setImporting,
	setPhase,
	setProfileJob,
	setProfileStartedAt,
	setReviewedAgentSuggestions,
	setSelectedAgentSuggestions,
	setSubmitting,
	submitting,
	threadGroups,
}: OnboardingProfileFlowInput) {
	const tl = useLiteralMessages();
	const tlRef = useRef(tl);
	tlRef.current = tl;
	const eligibleForProfile = useCallback(() => {
		const selectedOrg = organizations.find(
			(organization) => organization.id === selectedOrganizationId
		);
		const role = selectedOrg?.role?.toLowerCase();
		const ownerOrAdmin = role === "owner" || role === "admin";
		const companyKnowledgeReady =
			nodeSetupKind !== "team" || companyKnowledgeEnabled;
		// A paid owner/admin can build a useful first draft even before connecting
		// a source: the agent can use imported sessions and the agent group itself.
		// Connected source ids are still passed when available, and Core performs
		// the authoritative paid-plan/role/consent check before materialising.
		return (
			entitlementStateRef.current.paid && ownerOrAdmin && companyKnowledgeReady
		);
	}, [
		companyKnowledgeEnabled,
		nodeSetupKind,
		organizations,
		selectedOrganizationId,
	]);
	// Advance to the optional microphone step. Voice input is opt-in, so this
	// never blocks finishing — it just gives the OS mic prompt a controlled moment
	// with our own copy instead of firing mid-chat.
	const goToMic = useCallback(() => {
		setPhase("mic");
	}, []);
	const continueAfterNode = useCallback(() => {
		if (desktopOnboardingPending) {
			setPhase(nodeOnboardingPending ? "safety" : "guidance");
			return;
		}
		finishNodeOnly();
	}, [desktopOnboardingPending, finishNodeOnly, nodeOnboardingPending]);
	const goToTelegram = useCallback(() => {
		continueAfterNode();
	}, [continueAfterNode]);
	const continueAfterImports = useCallback(() => {
		if (gatewaySetupAllowed && eligibleForProfile()) {
			setPhase("profile");
			return;
		}
		goToTelegram();
	}, [eligibleForProfile, gatewaySetupAllowed, goToTelegram]);
	const continueAfterProfile = useCallback(() => {
		const suggestions = profileJob?.agentSuggestions ?? [];
		if (suggestions.length > 0) {
			setAgentSuggestions(suggestions);
			setSelectedAgentSuggestions(new Set());
			setReviewedAgentSuggestions(new Set());
			setAgentSuggestionIdentityModes(new Map());
			setAgentSuggestionsError(null);
			setPhase("agent-suggestions");
			return;
		}
		goToTelegram();
	}, [goToTelegram, profileJob]);
	const toggleAgentSuggestion = useCallback((id: string) => {
		setSelectedAgentSuggestions((current) => {
			const next = new Set(current);
			if (next.has(id)) {
				next.delete(id);
			} else {
				next.add(id);
			}
			return next;
		});
	}, []);
	const reviewAgentSuggestion = useCallback((id: string, reviewed: boolean) => {
		setReviewedAgentSuggestions((current) => {
			const next = new Set(current);
			if (reviewed) {
				next.add(id);
			} else {
				next.delete(id);
			}
			return next;
		});
	}, []);
	const setAgentSuggestionIdentityMode = useCallback(
		(id: string, mode: AgentIdentityMode) => {
			setAgentSuggestionIdentityModes((current) => {
				const next = new Map(current);
				next.set(id, mode);
				return next;
			});
		},
		[]
	);
	const createOnboardingAgents = useCallback(async () => {
		if (agentSuggestionsSubmitting || selectedAgentSuggestions.size === 0) {
			return;
		}
		const unreviewed = agentSuggestions.filter(
			(suggestion) =>
				selectedAgentSuggestions.has(suggestion.id) &&
				!reviewedAgentSuggestions.has(suggestion.id)
		);
		if (unreviewed.length > 0) {
			setAgentSuggestionsError(
				tlRef.current(
					"Review {count, plural, one {# selected draft} other {# selected drafts}} before adding it.",
					{ count: unreviewed.length }
				)
			);
			return;
		}
		setAgentSuggestionsSubmitting(true);
		setAgentSuggestionsError(null);
		const target = toTarget(getActiveNode());
		const chosen = agentSuggestions.filter((suggestion) =>
			selectedAgentSuggestions.has(suggestion.id)
		);
		const existingAgents = await fetchAgents(target).catch(() => null);
		if (!existingAgents) {
			setAgentSuggestionsError(
				"Ryu couldn't verify your current agents. Try again or skip for now."
			);
			setAgentSuggestionsSubmitting(false);
			return;
		}
		const failed: OnboardingAgentSuggestion[] = [];
		// Suggestions Core said would not start under their chosen identity,
		// with Core's reason. They are not created.
		const refused: string[] = [];
		// Suggestions whose create call failed for another reason.
		const createFailed: OnboardingAgentSuggestion[] = [];
		let blockedByLimit = false;
		let createdCount = 0;

		for (const [index, suggestion] of chosen.entries()) {
			if (
				!guardAgentCreation("maxAgents", existingAgents.length + createdCount)
			) {
				blockedByLimit = true;
				failed.push(...chosen.slice(index));
				break;
			}
			const identityMode = suggestionIdentityMode(
				agentSuggestionIdentityModes,
				suggestion.id
			);
			// "Acts as you" with no account limit is how every agent ran before
			// identity modes, so only another mode needs Core's launch check.
			// A check that fails to answer does not block, as in the New agent
			// dialog; Core checks again before every start.
			const refusal =
				identityMode === "managed"
					? null
					: await checkAgentLaunch(target, {
							accountAccess: null,
							engine: SUGGESTED_AGENT_ENGINE,
							identityMode,
						})
							.then((check) =>
								check.launchable
									? null
									: (check.reason ?? "Ryu won't start this agent.")
							)
							.catch(() => null);
			if (refusal) {
				refused.push(
					`${suggestion.name} can't start as "${AGENT_IDENTITY_MODE_OPTIONS[identityMode].title}": ${refusal}`
				);
				failed.push(suggestion);
				continue;
			}
			try {
				await createAgent(
					target,
					buildSuggestedAgentInput(suggestion, cloudSelection, identityMode)
				);
				createdCount++;
			} catch {
				failed.push(suggestion);
				createFailed.push(suggestion);
			}
		}

		if (createdCount > 0) {
			triggerAgentsRefresh();
			sileo.success({
				title: tlRef.current(
					"{count, plural, one {# suggested agent} other {# suggested agents}} added",
					{ count: createdCount }
				),
				description:
					createdCount === 1
						? "It is ready for your next task."
						: "They are ready for your next task.",
			});
		}

		if (failed.length > 0) {
			setAgentSuggestions((current) =>
				current.filter((suggestion) =>
					failed.some((item) => item.id === suggestion.id)
				)
			);
			setSelectedAgentSuggestions(
				new Set(failed.map((suggestion) => suggestion.id))
			);
			setAgentSuggestionsError(
				agentSuggestionsFailureMessage(tlRef.current, {
					blockedByLimit,
					createdCount,
					createFailedNames: createFailed.map((suggestion) => suggestion.name),
					failedNames: failed.map((suggestion) => suggestion.name),
					refused,
				})
			);
		} else {
			setSelectedAgentSuggestions(new Set());
			setReviewedAgentSuggestions(new Set());
			goToTelegram();
		}
		setAgentSuggestionsSubmitting(false);
	}, [
		agentSuggestionIdentityModes,
		agentSuggestions,
		agentSuggestionsSubmitting,
		cloudSelection,
		guardAgentCreation,
		getActiveNode,
		goToTelegram,
		reviewedAgentSuggestions,
		selectedAgentSuggestions,
	]);
	const importOnboardingThreads = useCallback(async () => {
		if (importing) {
			return;
		}
		setImporting(true);
		const target = toTarget(getActiveNode());
		const imported: string[] = [];
		for (const group of threadGroups) {
			for (const thread of group.threads) {
				const result = await importAgentThread(
					target,
					group.agentId,
					thread.id
				).catch(() => null);
				if (result?.conversationId) {
					imported.push(result.conversationId);
				}
			}
		}
		setImportedConversationIds(imported);
		setImporting(false);
		continueAfterImports();
	}, [continueAfterImports, getActiveNode, importing, threadGroups]);
	const startOnboardingProfile = useCallback(() => {
		if (profileJob && profileJob.state !== "failed") {
			return;
		}
		setProfileJob(null);
		const target = toTarget(getActiveNode());
		void startProfileJob(target, {
			cloudSelection,
			importedConversationIds,
			recentDays: 90,
			shareUserOrg: nodeSetupKind === "team",
			sourceIds: connections
				.filter((connection) => connection.active)
				.map((connection) => connection.id),
		})
			.then((job) => {
				setProfileJob(job);
				setProfileStartedAt(job.startedAtMs);
			})
			.catch(() => goToTelegram());
	}, [
		cloudSelection,
		connections,
		getActiveNode,
		goToTelegram,
		importedConversationIds,
		nodeSetupKind,
		profileJob,
	]);
	const cancelOnboardingProfile = useCallback(() => {
		const job = profileJob;
		if (!job) {
			goToTelegram();
			return;
		}
		void cancelProfileJob(toTarget(getActiveNode()), job.id).finally(() => {
			setProfileJob(null);
			goToTelegram();
		});
	}, [getActiveNode, profileJob]);
	const backgroundOnboardingProfile = useCallback(() => {
		if (!profileJob) {
			return;
		}
		void continueProfileJobInBackground(
			toTarget(getActiveNode()),
			profileJob.id
		).then(setProfileJob);
	}, [getActiveNode, goToTelegram, profileJob]);
	const skipCloudDefault = useCallback(async () => {
		if (submitting) {
			return;
		}
		setCloudSelection(EMPTY_AGENT_SELECTION);
		setSubmitting(true);
		await setLaneAgentSelection(
			toTarget(getActiveNode()),
			"cloud",
			EMPTY_AGENT_SELECTION
		).catch(() => false);
		setSubmitting(false);
		await scanOnboardingThreads();
	}, [getActiveNode, scanOnboardingThreads, submitting]);
	useEffect(() => {
		if (
			phase !== "profile" ||
			!profileJob ||
			(profileJob.state !== "queued" && profileJob.state !== "building")
		) {
			return;
		}
		const interval = window.setInterval(() => {
			void getProfileJobStatus(toTarget(getActiveNode()), profileJob.id)
				.then(setProfileJob)
				.catch(() => undefined);
		}, 1000);
		return () => window.clearInterval(interval);
	}, [getActiveNode, phase, profileJob]);
	return {
		backgroundOnboardingProfile,
		cancelOnboardingProfile,
		continueAfterImports,
		continueAfterNode,
		continueAfterProfile,
		createOnboardingAgents,
		goToMic,
		goToTelegram,
		importOnboardingThreads,
		reviewAgentSuggestion,
		setAgentSuggestionIdentityMode,
		skipCloudDefault,
		startOnboardingProfile,
		toggleAgentSuggestion,
	};
}
