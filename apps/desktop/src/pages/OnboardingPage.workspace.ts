import { useCallback } from "react";
import { sileo } from "sileo";
import { openExternal } from "@/lib/tauri-bridge.ts";
import type { OnboardingThreadGroup } from "@/src/components/onboarding/OnboardingSetupStep.tsx";
import { listAgentThreads } from "@/src/lib/api/agent-threads.ts";
import { listChannels } from "@/src/lib/api/channels.ts";
import { type ApiTarget, toTarget } from "@/src/lib/api/client.ts";
import {
	type ComposioToolkit,
	fetchComposioConnectionStatus,
	fetchComposioConnections,
	fetchComposioStatus,
	fetchComposioToolkits,
	initiateComposioConnection,
} from "@/src/lib/api/composio.ts";
import {
	fetchGatewayOnboardingAccess,
	fetchProfileAvailability,
} from "@/src/lib/api/onboarding-profile.ts";
import { getActiveOrgId, listOrgs, setActiveOrg } from "@/src/lib/api/orgs.ts";
import { configureProvider, fetchPiCatalog } from "@/src/lib/api/pi-config.ts";
import {
	defaultCloudAgentSelection,
	setLaneAgentSelection,
} from "@/src/lib/api/preferences.ts";
import type { ConnectionAccessLevel } from "@/src/lib/connection-permissions.ts";
import { sleep } from "./OnboardingPage.local-stack.ts";
import type { useOnboardingPhase } from "./OnboardingPage.phase.ts";
import type { useOnboardingSetupState } from "./OnboardingPage.setup-state.ts";
import type { useOnboardingFlowState } from "./OnboardingPage.state.ts";

type OnboardingWorkspaceInput = Pick<
	ReturnType<typeof useOnboardingFlowState>,
	| "allowedAgentIds"
	| "cloudSelection"
	| "foundAgents"
	| "localSelection"
	| "setCloudSelection"
	| "setLaneSaveError"
	| "setSubmitting"
	| "submitting"
	| "suggestedAgents"
> &
	Pick<
		ReturnType<typeof useOnboardingSetupState>,
		| "connectingToolkit"
		| "entitlementStateRef"
		| "paidPlan"
		| "providerBusyId"
		| "selectedOrganizationId"
		| "setChannelConfigs"
		| "setConfiguredProviderIds"
		| "setConnectingToolkit"
		| "setConnections"
		| "setConnectionsCheckFailed"
		| "setGatewayAccess"
		| "setGatewaySetupAllowed"
		| "setOrganizations"
		| "setPiProviders"
		| "setProfileAlreadyBuilt"
		| "setProviderBusyId"
		| "setSelectedOrganizationId"
		| "setThreadGroups"
		| "setToolkits"
		| "waitForPaidPlan"
	> &
	Pick<
		ReturnType<typeof useOnboardingPhase>,
		"getActiveNode" | "nodeOnboardingPending" | "setPhase"
	>;

/** Organization, providers, connections, and lane defaults. */
export function useOnboardingWorkspace({
	allowedAgentIds,
	cloudSelection,
	connectingToolkit,
	entitlementStateRef,
	foundAgents,
	getActiveNode,
	localSelection,
	nodeOnboardingPending,
	paidPlan,
	providerBusyId,
	selectedOrganizationId,
	setChannelConfigs,
	setCloudSelection,
	setConfiguredProviderIds,
	setConnectingToolkit,
	setConnections,
	setConnectionsCheckFailed,
	setGatewayAccess,
	setGatewaySetupAllowed,
	setLaneSaveError,
	setOrganizations,
	setPhase,
	setPiProviders,
	setProfileAlreadyBuilt,
	setProviderBusyId,
	setSelectedOrganizationId,
	setSubmitting,
	setThreadGroups,
	setToolkits,
	submitting,
	suggestedAgents,
	waitForPaidPlan,
}: OnboardingWorkspaceInput) {
	const loadProviderCatalog = useCallback(async (target: ApiTarget) => {
		try {
			const catalog = await fetchPiCatalog(target);
			setPiProviders(catalog.providers);
			setConfiguredProviderIds(
				catalog.providers
					.filter((provider) => provider.configured)
					.map((provider) => provider.id)
			);
		} catch {
			setPiProviders([]);
			setConfiguredProviderIds([]);
		}
	}, []);
	const loadOnboardingConnections = useCallback(async (target: ApiTarget) => {
		const composio = await fetchComposioStatus(target).catch(() => ({
			baseUrl: "",
			configured: false,
		}));
		if (!composio.configured) {
			setToolkits([]);
			setConnections([]);
			setConnectionsCheckFailed(false);
			return;
		}
		const [loadedToolkits, loadedConnections] = await Promise.all([
			fetchComposioToolkits(target).catch(() => []),
			fetchComposioConnections(target).catch(() => null),
		]);
		setToolkits(loadedToolkits);
		setConnections(loadedConnections ?? []);
		setConnectionsCheckFailed(loadedConnections === null);
	}, []);
	const loadOrganizationSetup = useCallback(async () => {
		setSubmitting(true);
		setConnectionsCheckFailed(false);
		setProfileAlreadyBuilt(null);
		const activeNode = getActiveNode();
		const target = toTarget(activeNode);
		const access = await fetchGatewayOnboardingAccess(target).catch(() => null);
		setGatewayAccess(access);
		const allowed = access?.allowed ?? !activeNode.managed;
		setGatewaySetupAllowed(allowed);
		if (!allowed) {
			setSubmitting(false);
			setPhase("cloud-default");
			return;
		}
		const [existingChannels, profileAvailability] = await Promise.all([
			listChannels().catch(() => null),
			fetchProfileAvailability(target).catch(() => null),
		]);
		setChannelConfigs(existingChannels);
		setProfileAlreadyBuilt(profileAvailability?.completed ?? null);
		const paid = await waitForPaidPlan();
		const listed = await listOrgs().catch(() => []);
		const active = await getActiveOrgId().catch(() => null);
		const normalized = listed.map((organization) => ({
			id: organization.id,
			isPersonal: organization.isPersonal,
			logo: organization.logo,
			name: organization.name,
			role: organization.role,
			slug: organization.slug,
		}));
		setOrganizations(normalized);
		const selected =
			(active && normalized.some((organization) => organization.id === active)
				? active
				: normalized[0]?.id) ?? null;
		setSelectedOrganizationId(selected);
		if (normalized.length > 1) {
			setSubmitting(false);
			setPhase("organization");
			return;
		}
		if (selected) {
			await setActiveOrg(selected).catch(() => undefined);
		}
		await loadProviderCatalog(target);
		await loadOnboardingConnections(target);
		if (paid) {
			setCloudSelection((current) =>
				current.agent_id || current.model
					? current
					: defaultCloudAgentSelection(true)
			);
			setSubmitting(false);
			setPhase("cloud-default");
		} else {
			setSubmitting(false);
			setPhase(nodeOnboardingPending ? "safety" : "guidance");
		}
	}, [
		getActiveNode,
		loadOnboardingConnections,
		loadProviderCatalog,
		nodeOnboardingPending,
		waitForPaidPlan,
	]);
	const continueLocalDefault = useCallback(async () => {
		if (submitting) {
			return;
		}
		setSubmitting(true);
		const target = toTarget(getActiveNode());
		setLaneSaveError(null);
		const saved = await setLaneAgentSelection(
			target,
			"local",
			localSelection
		).catch(() => false);
		setSubmitting(false);
		if (!saved) {
			setLaneSaveError("Could not save your local default. Try again.");
			return;
		}
		await loadOrganizationSetup();
	}, [getActiveNode, loadOrganizationSetup, localSelection, submitting]);
	const continueOrganization = useCallback(async () => {
		if (submitting || !selectedOrganizationId) {
			return;
		}
		setSubmitting(true);
		const paid = await waitForPaidPlan();
		await setActiveOrg(selectedOrganizationId).catch(() => undefined);
		const target = toTarget(getActiveNode());
		const access = await fetchGatewayOnboardingAccess(target).catch(() => null);
		setGatewayAccess(access);
		setGatewaySetupAllowed(access?.allowed ?? !getActiveNode().managed);
		const profileAvailability = await fetchProfileAvailability(target).catch(
			() => null
		);
		setProfileAlreadyBuilt(profileAvailability?.completed ?? null);
		await loadProviderCatalog(target);
		await loadOnboardingConnections(target);
		if (paid) {
			setCloudSelection((current) =>
				current.agent_id || current.model
					? current
					: defaultCloudAgentSelection(true)
			);
			setPhase("cloud-default");
		} else {
			setPhase(nodeOnboardingPending ? "safety" : "guidance");
		}
		setSubmitting(false);
	}, [
		getActiveNode,
		loadOnboardingConnections,
		loadProviderCatalog,
		selectedOrganizationId,
		nodeOnboardingPending,
		submitting,
		waitForPaidPlan,
	]);
	const continueProviders = useCallback(() => {
		if (submitting) {
			return;
		}
		setPhase("cloud-default");
	}, [submitting]);
	const configureOnboardingProvider = useCallback(
		(providerId: string, apiKey: string) => {
			if (providerBusyId) {
				return;
			}
			setProviderBusyId(providerId);
			const target = toTarget(getActiveNode());
			configureProvider(target, { apiKey, provider: providerId })
				.then((catalog) => {
					setPiProviders(catalog.providers);
					setConfiguredProviderIds(
						catalog.providers
							.filter((provider) => provider.configured)
							.map((provider) => provider.id)
					);
				})
				.catch(() => undefined)
				.finally(() => setProviderBusyId(null));
		},
		[getActiveNode, providerBusyId]
	);
	const connectOnboardingToolkit = useCallback(
		async (toolkit: ComposioToolkit, accessLevel: ConnectionAccessLevel) => {
			if (connectingToolkit) {
				return;
			}
			setConnectingToolkit(toolkit.slug);
			const target = toTarget(getActiveNode());
			try {
				const result = await initiateComposioConnection(
					target,
					toolkit.slug,
					accessLevel
				);
				if (result.redirectUrl) {
					await openExternal(result.redirectUrl);
				}
				await sleep(1800);
				const connection = await fetchComposioConnectionStatus(
					target,
					result.connectionId
				).catch(() => null);
				if (connection) {
					setConnections((current) => [
						...current.filter((item) => item.id !== connection.id),
						connection,
					]);
				}
			} catch (error) {
				sileo.error({
					title:
						error instanceof Error
							? error.message
							: "Could not start the connection.",
				});
				throw error;
			} finally {
				setConnectingToolkit(null);
			}
		},
		[connectingToolkit, getActiveNode]
	);
	const scanOnboardingThreads = useCallback(async () => {
		setSubmitting(true);
		const target = toTarget(getActiveNode());
		const names = new Map<string, string>();
		for (const agent of [...foundAgents, ...suggestedAgents]) {
			names.set(agent.id, agent.name);
		}
		const cutoff = Date.now() - 90 * 24 * 60 * 60 * 1000;
		const groups: OnboardingThreadGroup[] = [];
		for (const agentId of allowedAgentIds.filter((id) => id !== "ryu")) {
			const result = await listAgentThreads(target, agentId).catch(() => null);
			if (!result?.supported) {
				continue;
			}
			const recent = result.threads.filter(
				(thread) => thread.updatedAt >= cutoff
			);
			if (recent.length > 0) {
				groups.push({
					agentId,
					agentName: names.get(agentId) ?? agentId,
					threads: recent,
				});
			}
		}
		setThreadGroups(groups);
		setSubmitting(false);
		setPhase("imports");
	}, [allowedAgentIds, foundAgents, getActiveNode, suggestedAgents]);
	const continueConnections = useCallback(() => {
		if (submitting) {
			return;
		}
		if (
			entitlementStateRef.current.paid &&
			!cloudSelection.agent_id &&
			!cloudSelection.model
		) {
			setCloudSelection(defaultCloudAgentSelection(true));
		}
		setPhase("cloud-default");
	}, [cloudSelection, paidPlan, submitting]);
	const continueCloudDefault = useCallback(async () => {
		if (submitting) {
			return;
		}
		setSubmitting(true);
		const target = toTarget(getActiveNode());
		setLaneSaveError(null);
		const saved = await setLaneAgentSelection(
			target,
			"cloud",
			cloudSelection
		).catch(() => false);
		setSubmitting(false);
		if (!saved) {
			setLaneSaveError("Could not save your cloud default. Try again.");
			return;
		}
		setPhase(nodeOnboardingPending ? "safety" : "guidance");
	}, [cloudSelection, getActiveNode, nodeOnboardingPending, submitting]);
	return {
		configureOnboardingProvider,
		connectOnboardingToolkit,
		continueCloudDefault,
		continueConnections,
		continueLocalDefault,
		continueOrganization,
		continueProviders,
		loadProviderCatalog,
		scanOnboardingThreads,
	};
}
