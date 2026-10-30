// apps/desktop/src/components/settings/AgentModelsSettings.tsx
//
// Per-model visibility for AGENTS, the third column of the model-toggle surface
// (Ryu providers · BYO-key providers · agents). An external agent — Claude Code,
// Codex, Gemini CLI — is not a Pi provider: it has no credential, no base URL and
// no routing, and it advertises its OWN model list over ACP. So it gets none of
// `ProviderCard`'s controls; the one thing it shares is the on/off switch per
// model, which is exactly what a user wants when an agent lists a dozen models
// and they use two.
//
// The toggles persist through the SAME `POST /api/pi-config/model-enabled`
// writer the providers use, under Core's reserved `agent:<id>` scope
// (`agentModelScope`). Core keeps those scopes out of the provider catalog and
// republishes them as `catalog.agentModelOverrides`, so nothing here needs a
// store of its own and every picker filters on one already-loaded catalog.
//
// Model lists are fetched lazily, on expand: `GET /acp-config` SPAWNS the agent's
// subprocess on first call (up to ~30s), so probing every installed agent when
// this tab merely renders would be a fleet of cold starts nobody asked for.

import { ArrowDown01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@ryu/ui/components/collapsible.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import { Spinner } from "@ryu/ui/components/spinner.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { sileo } from "sileo";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { AgentAvatar, engineForAgent } from "@/src/lib/agent-logos.tsx";
import { fetchAcpConfig, flattenConfigOptions } from "@/src/lib/api/acp.ts";
import type { AgentSummary } from "@/src/lib/api/agents.ts";
import { fetchAgents } from "@/src/lib/api/agents.ts";
import { agentModelScope } from "@/src/lib/api/pi-config.ts";
import { SettingsSection } from "./shared/settings-items.tsx";

/** The flagship agent id (mirrors Core `DEFAULT_AGENT_ID`). */
const RYU_AGENT_ID = "ryu";

interface AgentModel {
	id: string;
	name: string;
}

function errMessage<TError>(e: TError, fallback: string): string {
	return e instanceof Error && e.message ? e.message : fallback;
}

/**
 * One agent's models with a switch each. Expanding probes the agent's advertised
 * config; a model is visible in every picker unless its switch is off.
 */
function AgentCard({
	agent,
	overrides,
	onToggleModel,
}: {
	agent: AgentSummary;
	onToggleModel: (
		provider: string,
		model: string,
		enabled: boolean
	) => Promise<void>;
	overrides: Record<string, boolean> | undefined;
}) {
	const tl = useLiteralMessages();
	const node = useActiveNode();
	const [open, setOpen] = useState(false);
	const [toggling, setToggling] = useState<string | null>(null);

	const configQuery = useQuery({
		queryKey: ["acp-config", node.url, agent.id],
		queryFn: () =>
			fetchAcpConfig(
				{ url: node.url, token: node.token, userJwt: node.userJwt ?? null },
				agent.id
			),
		// Cold-start cost is the whole reason this is gated on `open`.
		enabled: open,
		staleTime: 5 * 60 * 1000,
		refetchOnWindowFocus: false,
	});

	// The agent's models, from whichever surface it advertises them on: the
	// dedicated ACP `models` capability, or a `category: "model"` config option.
	// Same priority order the composer's picker resolves, so what is toggleable
	// here is exactly what is offered there.
	const models = useMemo<AgentModel[]>(() => {
		const config = configQuery.data;
		const advertised = config?.models?.availableModels ?? [];
		if (advertised.length > 0) {
			return advertised.map((m) => ({ id: m.modelId, name: m.name }));
		}
		const option = (config?.configOptions ?? []).find(
			(opt) => opt.category === "model"
		);
		if (option) {
			return flattenConfigOptions(option).map((o) => ({
				id: o.value,
				name: o.name,
			}));
		}
		return [];
	}, [configQuery.data]);

	// The card starts collapsed and only probes on expand, so until the agent
	// answers, the persisted overrides are the only truth. Counting probed models
	// alone told every reopened Settings page "All models visible" while the
	// composer was already hiding the models switched off here.
	const hiddenCount =
		models.length > 0
			? models.filter((m) => overrides?.[m.id] === false).length
			: Object.values(overrides ?? {}).filter((enabled) => enabled === false)
					.length;

	const handleToggle = async (modelId: string, enabled: boolean) => {
		setToggling(modelId);
		try {
			await onToggleModel(agentModelScope(agent.id), modelId, enabled);
		} catch (e) {
			sileo.error({
				title: "Could not update model",
				description: errMessage(e, "Core rejected the request."),
			});
		} finally {
			setToggling(null);
		}
	};

	return (
		<div className="border-border border-b last:border-b-0">
			<Collapsible onOpenChange={setOpen} open={open}>
				<CollapsibleTrigger
					appearance="provider-group"
					className="flex min-h-12 w-full items-center justify-between px-0 py-3 text-left hover:bg-transparent"
				>
					<div className="flex min-w-0 items-center gap-2">
						<AgentAvatar
							className="size-4 shrink-0"
							engine={engineForAgent(agent)}
							glyph={agent.avatarGlyph}
						/>
						<div className="flex min-w-0 flex-col gap-0.5">
							<span className="text-sm">{agent.name}</span>
							<span className="text-detail text-muted-foreground">
								{hiddenCount > 0
									? tl(
											"{hiddenCount, plural, one {# model} other {# models}} hidden",
											{ hiddenCount }
										)
									: "All models visible"}
							</span>
						</div>
					</div>
					<HugeiconsIcon
						className={`size-4 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`}
						icon={ArrowDown01Icon}
					/>
				</CollapsibleTrigger>

				<CollapsibleContent
					className="flex flex-col px-0 pb-3"
					spacing="model-list"
				>
					{configQuery.isPending ? (
						<span className="flex items-center gap-1.5 text-detail text-muted-foreground">
							<Spinner className="size-3.5" />{" "}
							{tl("Asking {agentName} what it offers…", {
								agentName: agent.name,
							})}
						</span>
					) : null}
					{!configQuery.isPending && configQuery.isError ? (
						<span className="text-detail text-status-destructive">
							{tl("Could not read this agent's models: {error}", {
								error: errMessage(
									configQuery.error,
									"the agent did not respond."
								),
							})}
						</span>
					) : null}
					{!(configQuery.isPending || configQuery.isError) &&
					models.length === 0 ? (
						<span className="text-detail text-muted-foreground">
							This agent picks its own models, so there is nothing to hide.
						</span>
					) : null}
					{models.length > 0 ? (
						<div className="flex flex-col gap-1.5">
							<Label>Visible models</Label>
							<div className="flex max-h-64 flex-col overflow-y-auto">
								{models.map((m) => (
									<div
										className="flex min-h-9 items-center justify-between gap-2"
										key={m.id}
									>
										<span className="min-w-0 truncate text-sm" title={m.name}>
											{m.name}
										</span>
										<Switch
											// Absent from the overrides map ⇒ visible.
											aria-label={tl(
												"Show {modelName} in {agentName}'s model picker",
												{
													agentName: agent.name,
													modelName: m.name,
												}
											)}
											checked={overrides?.[m.id] !== false}
											disabled={toggling === m.id}
											onCheckedChange={(next) => handleToggle(m.id, next)}
										/>
									</div>
								))}
							</div>
						</div>
					) : null}
				</CollapsibleContent>
			</Collapsible>
		</div>
	);
}

export function AgentModelsSettings({
	agentModelOverrides,
	onToggleModel,
}: {
	agentModelOverrides: Record<string, Record<string, boolean>> | undefined;
	onToggleModel: (
		provider: string,
		model: string,
		enabled: boolean
	) => Promise<void>;
}) {
	const tl = useLiteralMessages();
	const node = useActiveNode();
	const agentsQuery = useQuery({
		queryKey: ["agents", node.url],
		queryFn: () =>
			fetchAgents({
				url: node.url,
				token: node.token,
				userJwt: node.userJwt ?? null,
			}),
		staleTime: 60_000,
	});

	// The flagship is deliberately absent. Ryu's models ARE the provider models the
	// cards above own, so a Ryu row here would be a SECOND switch for the same
	// model writing to a different scope (`agent:ryu` instead of the provider) —
	// two controls that disagree, where turning a model off in one leaves it
	// showing as on in the other.
	const agents = (agentsQuery.data ?? []).filter((a) => a.id !== RYU_AGENT_ID);

	return (
		<SettingsSection
			caption="Hide models you never use from an agent's picker. Separate from the provider lists above."
			title="Agent models"
		>
			{agentsQuery.isPending ? (
				<SkeletonRows label="Loading agents…" rows={2} />
			) : null}
			{agentsQuery.isError ? (
				<div
					className="flex min-h-12 flex-wrap items-center justify-between gap-6 py-3 text-sm"
					role="alert"
				>
					<span>
						{tl("Could not load agents: {error}", {
							error: errMessage(
								agentsQuery.error,
								"Core did not return the agent list."
							),
						})}
					</span>
					<Button
						disabled={agentsQuery.isFetching}
						onClick={() => void agentsQuery.refetch()}
						size="sm"
						variant="outline"
					>
						{agentsQuery.isFetching ? "Retrying…" : "Retry"}
					</Button>
				</div>
			) : null}
			{agents.length === 0 && !agentsQuery.isPending && !agentsQuery.isError ? (
				<p className="py-3 text-muted-foreground text-sm">
					No agents installed.
				</p>
			) : null}
			<div className="flex flex-col">
				{agents.map((agent) => (
					<AgentCard
						agent={agent}
						key={agent.id}
						onToggleModel={onToggleModel}
						overrides={agentModelOverrides?.[agent.id]}
					/>
				))}
			</div>
		</SettingsSection>
	);
}
