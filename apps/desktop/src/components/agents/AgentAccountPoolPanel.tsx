// apps/desktop/src/components/agents/AgentAccountPoolPanel.tsx
//
// Which accounts this agent uses. With a pool, the agent rotates only over
// that pool's saved provider accounts; when all of them are out of usage it
// stops instead of using an account outside the pool. With Auto, a request
// tries every saved account of its provider, one after another, until one can
// serve it. Below the choice sits the agent's ordered list of backup models
// (`AgentBackupModelsEditor`). Pools are created under LLM Providers
// (`AccountPoolsSettings`). Core stores and enforces the choice
// (`/api/pi-config/providers/account-pools/agents/{id}`); a Core without Auto
// shows the pool choice only.

import { useLiteralMessages } from "@ryu/i18n/react";
import { Label } from "@ryu/ui/components/label.tsx";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select.tsx";
import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useMemo, useState } from "react";
import {
	SettingsCard,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import {
	type AgentAccountMode,
	accountPoolsQueryKey,
	accountPoolsUnsupported,
	agentAccountMode,
	type BackupModel,
	fetchAccountPools,
	setAgentAccountMode,
	setAgentAccountPool,
	supportsAutoMode,
} from "@/src/lib/api/account-pools.ts";
import { ApiError, toTarget } from "@/src/lib/api/client.ts";
import { fetchPiCatalog } from "@/src/lib/api/pi-config.ts";
import {
	AgentBackupModelsEditor,
	type BackupProvider,
} from "./AgentBackupModelsEditor.tsx";

/** The select value that stands for "no pool". Pool ids are never empty. */
const NO_POOL = "none";
/** The select value for Auto. Pool ids hold no control characters. */
const AUTO = "\u0000auto";

interface Choice {
	backups?: BackupModel[];
	mode: AgentAccountMode;
	poolId: string | null;
}

export function AgentAccountPoolPanel({
	agentId,
	disabled = false,
}: {
	agentId: string;
	disabled?: boolean;
}) {
	const tl = useLiteralMessages();
	const node = useActiveNode();
	const target = useMemo(
		() => toTarget(node),
		[node.token, node.url, node.userJwt]
	);
	const queryClient = useQueryClient();
	const queryKey = accountPoolsQueryKey(target);
	const query = useQuery({
		queryKey,
		queryFn: () => fetchAccountPools(target),
	});
	const autoKnown = query.data ? supportsAutoMode(query.data) : false;
	const catalog = useQuery({
		enabled: autoKnown,
		queryFn: () => fetchPiCatalog(target),
		queryKey: ["pi-config-catalog", target.url, "agent-backup-models"],
		staleTime: 30_000,
	});
	const providers = useMemo<BackupProvider[]>(
		() =>
			(catalog.data?.providers ?? []).map((provider) => ({
				id: provider.id,
				label: provider.label,
				models: provider.suggestedModels,
			})),
		[catalog.data]
	);
	const selectId = useId();
	const [error, setError] = useState<string | null>(null);
	const assign = useMutation({
		mutationFn: async (choice: Choice) =>
			autoKnown
				? await setAgentAccountMode(target, agentId, choice)
				: await setAgentAccountPool(target, agentId, choice.poolId),
		onError: (cause) => {
			setError(
				cause instanceof ApiError && cause.serverMessage
					? cause.serverMessage
					: tl("Could not save the account pool of this agent.")
			);
		},
		onSuccess: () => {
			setError(null);
			queryClient.invalidateQueries({ queryKey }).catch(() => undefined);
		},
	});

	const renderBody = () => {
		if (query.isError) {
			return (
				<p className="text-detail text-status-destructive" role="alert">
					Could not load account pools.
				</p>
			);
		}
		if (query.isPending) {
			return (
				<SkeletonRows label="Loading account pools…" spacing="comfortable" />
			);
		}
		const { agents, pools } = query.data;
		if (pools.length === 0 && !autoKnown) {
			return (
				<p className="text-muted-foreground text-sm">
					No account pools yet. Create one in the LLM provider settings.
				</p>
			);
		}
		const mode = agentAccountMode(query.data, agentId);
		const assigned = pools.find((pool) => pool.id === agents[agentId]);
		const backups = query.data.backups?.[agentId] ?? [];
		const current: Choice = { mode, poolId: assigned?.id ?? null };
		let shown = tl("All accounts (no pool)");
		let selected = assigned?.id ?? NO_POOL;
		if (mode === "auto") {
			shown = tl("Auto (try every account)");
			selected = AUTO;
		} else if (assigned) {
			shown = assigned.name;
		}
		const onValueChange = (value: string) => {
			if (value === AUTO) {
				if (mode !== "auto") {
					assign.mutate({ mode: "auto", poolId: null });
				}
				return;
			}
			const poolId = pools.find((pool) => pool.id === value)?.id ?? null;
			const next: AgentAccountMode = poolId ? "pool" : "none";
			if (next !== mode || poolId !== current.poolId) {
				assign.mutate({ mode: next, poolId });
			}
		};
		return (
			<SettingsCard className="flex flex-col gap-4">
				<div className="space-y-1.5">
					<Label htmlFor={selectId}>Account pool</Label>
					<Select
						disabled={disabled || assign.isPending}
						onValueChange={onValueChange}
						value={selected}
					>
						<SelectTrigger id={selectId}>
							<SelectValue>{shown}</SelectValue>
						</SelectTrigger>
						<SelectContent>
							<SelectItem value={NO_POOL}>All accounts (no pool)</SelectItem>
							{autoKnown ? (
								<SelectItem value={AUTO}>Auto (try every account)</SelectItem>
							) : null}
							{pools.map((pool) => (
								<SelectItem key={pool.id} value={pool.id}>
									{pool.name}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					{mode === "auto" ? (
						<p className="text-detail text-muted-foreground">
							Each request tries the saved accounts of its provider one after
							another. An account at its usage limit is skipped until its reset,
							and one without the model is skipped for that model.
						</p>
					) : null}
				</div>
				{autoKnown ? (
					<AgentBackupModelsEditor
						backups={backups}
						busy={assign.isPending}
						disabled={disabled}
						max={query.data.maxBackups ?? 0}
						onChange={(next) => assign.mutate({ ...current, backups: next })}
						providers={providers}
					/>
				) : null}
				{error ? (
					<p className="text-detail text-status-destructive" role="alert">
						{error}
					</p>
				) : null}
			</SettingsCard>
		);
	};

	// A node on an older Core has no account pools: show nothing.
	if (accountPoolsUnsupported(query.error)) {
		return null;
	}

	return (
		<SettingsSection
			caption={
				query.data && supportsAutoMode(query.data)
					? tl(
							"With a pool, this agent uses only the saved accounts of that pool. With Auto, it tries every saved account until one can serve the request. When every account is out of usage, the agent stops with one message that says when the first one resets."
						)
					: tl(
							"With a pool, this agent uses only the saved accounts of that pool. When all of them are out of usage, the agent stops and does not use any other account."
						)
			}
			title="Account pool"
		>
			{renderBody()}
		</SettingsSection>
	);
}
