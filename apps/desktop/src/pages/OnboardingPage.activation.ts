import { useCallback } from "react";
import { openExternal } from "@/lib/tauri-bridge.ts";
import {
	CheckoutError,
	createCheckout,
	fetchEntitlementStatus,
} from "@/src/lib/api/billing.ts";
import { toTarget } from "@/src/lib/api/client.ts";
import {
	fetchComposioConnectionStatus,
	initiateComposioConnection,
} from "@/src/lib/api/composio.ts";
import {
	claimActivationReward,
	saveOnboardingSource,
} from "@/src/lib/api/onboarding-activation.ts";
import { createQuest } from "@/src/lib/api/quests.ts";
import { checkoutTeamsOnboarding } from "@/src/lib/api/teams-billing.ts";
import type { ConnectionAccessLevel } from "@/src/lib/connection-permissions.ts";
import {
	type ActivationRecommendation,
	activationStartAction,
	buildActivationRecommendations,
} from "@/src/lib/onboarding-activation.ts";
import { buildOnboardingTaskRouteState } from "@/src/lib/onboarding-navigation.ts";
import { isLocalNode } from "@/src/store/useNodeStore.ts";
import { refreshLocalNode, sleep } from "./OnboardingPage.local-stack.ts";
import type { useOnboardingNodeSetup } from "./OnboardingPage.node-setup.ts";
import type { useOnboardingPhase } from "./OnboardingPage.phase.ts";
import type { useOnboardingSetupState } from "./OnboardingPage.setup-state.ts";
import type { useOnboardingFlowState } from "./OnboardingPage.state.ts";
import type { useOnboardingSteps } from "./OnboardingPage.steps.ts";

type OnboardingActivationInput = Pick<
	ReturnType<typeof useOnboardingSetupState>,
	| "activationBusySlug"
	| "activationCheckoutPending"
	| "activationEligibility"
	| "activationRecommendations"
	| "activationTask"
	| "activationTaskPending"
	| "activationUsesOrganizationPlan"
	| "connections"
	| "paidPlan"
	| "selectedOrganizationId"
	| "setActivationBusySlug"
	| "setActivationCheckoutOpened"
	| "setActivationCheckoutPending"
	| "setActivationError"
	| "setActivationRecommendations"
	| "setActivationSourceError"
	| "setActivationTaskPending"
	| "setActivationTaskSlug"
	| "setConnections"
	| "toolkits"
> &
	Pick<ReturnType<typeof useOnboardingNodeSetup>, "finish"> &
	Pick<ReturnType<typeof useOnboardingSteps>, "finishOnboarding"> &
	Pick<
		ReturnType<typeof useOnboardingPhase>,
		"getActiveNode" | "refreshCredits" | "setPhase" | "stepUp"
	> &
	Pick<
		ReturnType<typeof useOnboardingFlowState>,
		"setSubmitting" | "submitting"
	>;

/** Activation recommendations, checkout, and the first task. */
export function useOnboardingActivation({
	activationBusySlug,
	activationCheckoutPending,
	activationEligibility,
	activationRecommendations,
	activationTask,
	activationTaskPending,
	activationUsesOrganizationPlan,
	connections,
	finish,
	finishOnboarding,
	getActiveNode,
	paidPlan,
	refreshCredits,
	selectedOrganizationId,
	setActivationBusySlug,
	setActivationCheckoutOpened,
	setActivationCheckoutPending,
	setActivationError,
	setActivationRecommendations,
	setActivationSourceError,
	setActivationTaskPending,
	setActivationTaskSlug,
	setConnections,
	setPhase,
	setSubmitting,
	stepUp,
	submitting,
	toolkits,
}: OnboardingActivationInput) {
	const enterActivationApps = useCallback(() => {
		setActivationError(null);
		setActivationRecommendations(
			buildActivationRecommendations({ connections, toolkits })
		);
		setPhase("activation-apps");
	}, [connections, toolkits]);
	const handleActivationSource = useCallback(
		(source: Parameters<typeof saveOnboardingSource>[0]) => {
			if (submitting) {
				return;
			}
			setSubmitting(true);
			setActivationSourceError(null);
			void saveOnboardingSource(source)
				.then(enterActivationApps)
				.catch(() =>
					setActivationSourceError(
						"We couldn't save that answer. Try again or check your connection."
					)
				)
				.finally(() => setSubmitting(false));
		},
		[enterActivationApps, submitting]
	);
	const handleActivationConnect = useCallback(
		async (
			recommendation: ActivationRecommendation,
			accessLevel: ConnectionAccessLevel
		) => {
			const appSlug = recommendation.appSlug;
			if (!appSlug || activationBusySlug) {
				return;
			}
			setActivationBusySlug(appSlug);
			setActivationError(null);
			const target = toTarget(getActiveNode());
			try {
				const result = await initiateComposioConnection(
					target,
					appSlug,
					accessLevel
				);
				if (result.redirectUrl) {
					await openExternal(result.redirectUrl);
				}
				await sleep(1800);
				const connection = await fetchComposioConnectionStatus(
					target,
					result.connectionId
				);
				if (!connection.active) {
					throw new Error("The app connection is not active yet.");
				}
				const nextConnections = [
					...connections.filter((item) => item.id !== connection.id),
					connection,
				];
				setConnections(nextConnections);
				setActivationRecommendations(
					buildActivationRecommendations({
						connections: nextConnections,
						toolkits,
					})
				);
				if (activationEligibility.rewardAllowed) {
					try {
						await claimActivationReward({
							appSlug,
							connectionId: connection.id,
						});
					} catch {
						setActivationError(
							"Connected. Your bonus credit could not be confirmed yet."
						);
					}
				}
			} catch (error) {
				setActivationError(
					error instanceof Error
						? error.message
						: "The app connection could not be completed."
				);
				throw error;
			} finally {
				setActivationBusySlug(null);
			}
		},
		[
			activationBusySlug,
			activationEligibility.rewardAllowed,
			connections,
			getActiveNode,
			toolkits,
		]
	);
	const continueActivationApps = useCallback(() => {
		if (activationBusySlug) {
			return;
		}
		setActivationError(null);
		setActivationTaskSlug(null);
		setPhase("activation-task");
	}, [activationBusySlug]);
	const continueActivationValue = useCallback(() => {
		setActivationError(null);
		setPhase("activation-task");
	}, []);
	const confirmActivationSubscription = useCallback(async () => {
		if (activationCheckoutPending) {
			return;
		}
		setActivationCheckoutPending(true);
		setActivationError(null);
		const deadline = Date.now() + 30_000;
		try {
			while (Date.now() < deadline) {
				const status = await fetchEntitlementStatus().catch(() => null);
				if (status?.entitlement?.managedInference) {
					await refreshCredits();
					setActivationCheckoutPending(false);
					setActivationCheckoutOpened(false);
					setPhase("activation-task");
					return;
				}
				await sleep(1500);
			}
			setActivationError(
				"We haven't received the subscription confirmation yet. Return after the payment completes and try again."
			);
		} finally {
			setActivationCheckoutPending(false);
		}
	}, [activationCheckoutPending, refreshCredits]);
	const startActivationCheckout = useCallback(async () => {
		if (activationCheckoutPending) {
			return;
		}
		setActivationCheckoutPending(true);
		setActivationError(null);
		try {
			const checkout = await stepUp.guard("billing", async () => {
				if (activationUsesOrganizationPlan) {
					return (await checkoutTeamsOnboarding(selectedOrganizationId)).url;
				}
				return await createCheckout("pro-monthly");
			});
			if (checkout === null) {
				return;
			}
			await openExternal(checkout);
			setActivationCheckoutOpened(true);
			setActivationError(
				"Checkout is open in your browser. Finish there, return to Ryu, then confirm."
			);
		} catch (error) {
			setActivationError(
				error instanceof CheckoutError
					? error.message
					: "We couldn't start checkout. Try again."
			);
		} finally {
			setActivationCheckoutPending(false);
		}
	}, [
		activationCheckoutPending,
		activationUsesOrganizationPlan,
		selectedOrganizationId,
		stepUp,
	]);
	const continueActivationOffer = useCallback(() => {
		if (paidPlan) {
			setPhase("activation-task");
		}
	}, [paidPlan]);
	const startActivationTask = useCallback(async () => {
		if (activationTaskPending) {
			return;
		}
		if (!activationEligibility.taskAllowed) {
			setActivationError(
				"This workspace cannot create an onboarding task. Ask the node owner to continue."
			);
			return;
		}
		const action = activationStartAction({
			task: activationTask,
			recommendations: activationRecommendations,
			managedInference: paidPlan,
		});
		if (action === "connect") {
			setActivationError(
				"Connect the selected app before using its context, or choose your own model and context."
			);
			return;
		}
		if (action === "checkout") {
			setActivationError(null);
			setPhase("activation-offer");
			return;
		}
		setActivationTaskPending(true);
		setActivationError(null);
		try {
			const status = await fetchEntitlementStatus();
			if (!status.entitlement?.managedInference) {
				setPhase("activation-offer");
				setActivationError(
					"Confirm the subscription before starting this task."
				);
				return;
			}
			const active = getActiveNode();
			const node = isLocalNode(active) ? await refreshLocalNode() : active;
			const target = toTarget(node);
			const stored = localStorage.getItem("ryu_onboarding_activation_task");
			if (!stored) {
				const quest = await createQuest(target, {
					completion_condition:
						"The agent returns the requested task brief and the user confirms the result is useful.",
					detail: activationTask.prompt,
					title: activationTask.title,
				});
				localStorage.setItem(
					"ryu_onboarding_activation_task",
					JSON.stringify({ id: quest.id, title: quest.title })
				);
			}
			await finish(
				target,
				buildOnboardingTaskRouteState({
					prompt: activationTask.prompt,
					title: activationTask.title,
				})
			);
		} catch (error) {
			setActivationError(
				error instanceof Error
					? error.message
					: "The first task could not be created. Try again."
			);
		} finally {
			setActivationTaskPending(false);
		}
	}, [
		activationEligibility.taskAllowed,
		activationRecommendations,
		paidPlan,
		activationTask,
		activationTaskPending,
		finish,
		getActiveNode,
	]);
	const continueWithOwnModel = useCallback(() => {
		finishOnboarding(
			buildOnboardingTaskRouteState({
				prompt: `Help me with this task: ${activationTask.title}. Use only context I provide and ask me for that context first. Do not access external apps or change anything without asking.`,
				title: activationTask.title,
				autoSubmit: false,
			})
		);
	}, [activationTask.title, finishOnboarding]);
	const continueAfterPrivacy = useCallback(() => {
		if (activationEligibility.recommendationsAllowed) {
			enterActivationApps();
			return;
		}
		finishOnboarding();
	}, [
		activationEligibility.recommendationsAllowed,
		enterActivationApps,
		finishOnboarding,
	]);
	return {
		confirmActivationSubscription,
		continueActivationApps,
		continueActivationOffer,
		continueActivationValue,
		continueAfterPrivacy,
		continueWithOwnModel,
		enterActivationApps,
		handleActivationConnect,
		handleActivationSource,
		startActivationCheckout,
		startActivationTask,
	};
}
