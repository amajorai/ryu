import type { ComposioAccountOption } from "@ryu/blocks/desktop/agent-edit.tsx";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
	modeHasOwnAccounts,
	modeUsesYourAccounts,
} from "@/src/components/agents/AgentIdentityModePicker.tsx";
import { savedModeHasOwnApps } from "@/src/components/agents/agent-account-keys.ts";
import {
	useAgentComposioConnections,
	useComposioActions,
	useComposioConnections,
	useComposioStatus,
	useComposioToolkits,
	useComposioTriggers,
} from "@/src/hooks/useComposioCatalog.ts";
import {
	deleteTriggerSubscription,
	fetchTriggerSubscriptions,
	subscribeTrigger,
	type TriggerSubscription,
} from "@/src/lib/api/composio-triggers.ts";
import type { AgentEditBase } from "./AgentEditPage-base.ts";
import type { AgentEditFormState } from "./AgentEditPage-form-state.ts";

export type AgentEditComposio = ReturnType<typeof useAgentEditComposio>;

export function useAgentEditComposio(ctx: AgentEditBase & AgentEditFormState) {
	const {
		composioToolkit,
		existing,
		identityMode,
		isNew,
		agentId,
		accountAccess,
		setSelectedComposio,
		target,
		lifecycleStatus,
	} = ctx;
	// ── Composio browse (gateway-route actions) ──────────────────────────────────
	const composioStatus = useComposioStatus();
	const composioConfigured = composioStatus.data?.configured ?? false;
	const composioThroughConnect =
		composioStatus.data?.executionOwner === "connect";
	const composioToolkitsQuery = useComposioToolkits(composioConfigured);
	const composioActionsQuery = useComposioActions(composioToolkit);
	const composioTriggersQuery = useComposioTriggers(composioToolkit);
	const composioConnectionsQuery = useComposioConnections(
		"",
		composioConfigured
	);
	// The identity mode Core holds for this agent. Core keeps apps on an
	// agent's own identity only once it is saved as Its own identity or Both
	// (it answers 409 for one saved as Acts as you), so an unsaved switch offers
	// none until it is saved.
	const savedIdentityMode = existing?.identityMode ?? null;
	const ownAppsAvailable =
		modeHasOwnAccounts(identityMode) && savedModeHasOwnApps(savedIdentityMode);
	// The apps connected to this agent's own identity (Its own identity or
	// Both). Core answers 501 when a Connect service does not enable agent
	// accounts.
	const ownComposioConnectionsQuery = useAgentComposioConnections(
		isNew ? null : (agentId ?? null),
		ownAppsAvailable && composioConfigured && !isNew
	);
	// Accounts an event trigger may watch: the user's connected accounts that
	// this agent may use, and the active apps connected to its own identity
	// that its account access allows (only once the saved mode has them). A
	// limit narrows each to the ticked ones. Core re-checks both on subscribe
	// and on every event.
	const composioAccountOptions = useMemo<ComposioAccountOption[]>(() => {
		const labelOf = (connection: {
			active: boolean;
			id: string;
			status: string;
			toolkit: string;
		}) =>
			`${connection.toolkit} · ${connection.active ? "Active" : connection.status.toLowerCase() || "inactive"} · ${connection.id}`;
		const yours = modeUsesYourAccounts(identityMode)
			? (composioConnectionsQuery.data ?? []).filter(
					(connection) =>
						accountAccess === null ||
						accountAccess.includes(`composio:${connection.id}`)
				)
			: [];
		// A Connect service has no triggers on an agent's own apps (Core
		// answers 501), so none are offered there.
		const own =
			ownAppsAvailable && !composioThroughConnect
				? (ownComposioConnectionsQuery.data?.connections ?? []).filter(
						(connection) =>
							connection.active &&
							(accountAccess === null ||
								accountAccess.includes(`agent-composio:${connection.id}`))
					)
				: [];
		// Name the owner only when the agent may watch both kinds.
		const both = yours.length > 0 && own.length > 0;
		return [
			...yours.map(
				(connection): ComposioAccountOption => ({
					id: connection.id,
					label: labelOf(connection),
					owner: both ? "you" : undefined,
					toolkit: connection.toolkit,
				})
			),
			...own.map(
				(connection): ComposioAccountOption => ({
					id: connection.id,
					label: labelOf(connection),
					owner: "agent",
					toolkit: connection.toolkit,
				})
			),
		];
	}, [
		composioThroughConnect,
		accountAccess,
		composioConnectionsQuery.data,
		identityMode,
		ownAppsAvailable,
		ownComposioConnectionsQuery.data,
	]);

	// ── Composio event-trigger subscriptions for this agent ──────────────────────
	const [triggerSubs, setTriggerSubs] = useState<TriggerSubscription[]>([]);
	const [triggerSlug, setTriggerSlug] = useState("");
	const [connectedAccountId, setConnectedAccountId] = useState("");
	const [subscribing, setSubscribing] = useState(false);
	const [triggerError, setTriggerError] = useState<string | null>(null);

	const toggleComposio = (name: string) => {
		setSelectedComposio((prev) => {
			const next = new Set(prev);
			if (next.has(name)) {
				next.delete(name);
			} else {
				next.add(name);
			}
			return next;
		});
	};

	// "All tools" for the selected connection: bulk-add every action currently
	// listed for the chosen toolkit. Snapshot semantics — tools Composio adds to
	// the toolkit later need a re-select (see the live-wildcard follow-up).
	const selectAllComposio = () => {
		const names = (composioActionsQuery.data ?? []).map((a) => a.name);
		if (names.length === 0) {
			return;
		}
		setSelectedComposio((prev) => {
			const next = new Set(prev);
			for (const name of names) {
				next.add(name);
			}
			return next;
		});
	};

	// Clear just the current toolkit's actions from the selection (leaves other
	// connections' selected actions intact).
	const clearComposioActions = () => {
		const names = new Set((composioActionsQuery.data ?? []).map((a) => a.name));
		setSelectedComposio((prev) => {
			const next = new Set(prev);
			for (const name of names) {
				next.delete(name);
			}
			return next;
		});
	};

	// ── Composio trigger subscriptions: load + subscribe + delete ────────────────
	const loadTriggerSubs = useCallback(async () => {
		if (isNew || !agentId) {
			return;
		}
		try {
			const subs = await fetchTriggerSubscriptions(target);
			setTriggerSubs(subs.filter((s) => s.agentId === agentId));
		} catch {
			// Non-fatal: triggers list is best-effort.
		}
	}, [agentId, isNew, target]);

	useEffect(() => {
		loadTriggerSubs();
	}, [loadTriggerSubs]);

	const handleSubscribeTrigger = async () => {
		if (lifecycleStatus !== "active") {
			setTriggerError("Promote this agent to Active before adding a trigger.");
			return;
		}
		if (
			!(agentId && composioToolkit && triggerSlug && connectedAccountId.trim())
		) {
			setTriggerError(
				"Pick a trigger event and enter the id of the account it should watch."
			);
			return;
		}
		setSubscribing(true);
		setTriggerError(null);
		try {
			const accountId = connectedAccountId.trim();
			await subscribeTrigger(target, {
				agentId,
				toolkit: composioToolkit,
				triggerSlug,
				connectedAccountId: accountId,
				ownAccount:
					composioAccountOptions.find((option) => option.id === accountId)
						?.owner === "agent",
			});
			setTriggerSlug("");
			setConnectedAccountId("");
			await loadTriggerSubs();
		} catch (e) {
			setTriggerError(e instanceof Error ? e.message : "Failed to subscribe");
		} finally {
			setSubscribing(false);
		}
	};

	const handleDeleteTrigger = async (id: string) => {
		try {
			await deleteTriggerSubscription(target, id);
			await loadTriggerSubs();
		} catch {
			// Non-fatal.
		}
	};
	return {
		composioStatus,
		composioConfigured,
		composioThroughConnect,
		composioToolkitsQuery,
		composioActionsQuery,
		composioTriggersQuery,
		composioConnectionsQuery,
		savedIdentityMode,
		ownAppsAvailable,
		ownComposioConnectionsQuery,
		composioAccountOptions,
		triggerSubs,
		setTriggerSubs,
		triggerSlug,
		setTriggerSlug,
		connectedAccountId,
		setConnectedAccountId,
		subscribing,
		setSubscribing,
		triggerError,
		setTriggerError,
		toggleComposio,
		selectAllComposio,
		clearComposioActions,
		loadTriggerSubs,
		handleSubscribeTrigger,
		handleDeleteTrigger,
	};
}
