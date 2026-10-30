// apps/desktop/src/components/gateway/AgentEgressSection.tsx
//
// "What is each of my agents actually allowed to do?" — answered as TWO
// questions, because Core asks two.
//
// Placed in the Safety filters section, directly under the command-approval
// card, because the firewall/DLP rules configured above it only ever see an
// agent whose model egress traverses the gateway. Without this list the rest of
// that section reads as node-wide policy when it is in fact per-agent routing for
// the ACP families (new/routable subscription and generic agents are direct by
// default; see
// `lib/api/agent-egress.ts` for the mechanism each family uses).
//
// ── Why every row is two rows ────────────────────────────────────────────────
// Until `agent_routing`'s split, ONE preference decided both whether Core swapped
// the agent's OpenAI base URL (moving a subscription credential and the billing
// path) and whether Core injected its MCP tool bridge (giving the agent the tool
// allowlist the user already configured for it). Declining the first silently
// removed the second, which is why a freshly installed ACP agent could not use a
// single Ryu tool.
//
// They are separate gates in Core now, and this panel's job is that they never
// look like one again:
//
//   * TWO controls per agent, each with its own badge, its own sentence and its
//     own timing caveat. Not one switch and a disclosure — one switch is what the
//     bug looked like.
//   * NO combined per-agent verdict, anywhere. There is no "Governed" pill and no
//     "N agents configured" count. Direct-with-tools and gateway-without-tools are
//     both ordinary, deliberate states; a single number over them would be read as
//     the answer and cannot be one.
//   * The two summaries are counted separately and never summed.
//
// ── Three deliberate refusals, all about not overclaiming ────────────────────
//
//  * A row shows a switch ONLY where flipping it changes what Core does. For
//    egress that means an agent Core marked `gateway_bypass` gets an explanation
//    instead of a dead control (the injection is, in Core's own words, "a genuine
//    no-op"), and the flagship Ryu row carries no egress switch because its
//    routing is a consequence of which provider the managed Pi is set to. For
//    tools it means the pi-acp family gets no switch: Core's own
//    `acp_bridge_supported` short-circuits before it ever reads the preference.
//    Note these are DIFFERENT sets of agents — `acp:gemini` can't be egress-routed
//    but takes tools fine; `acp:pi` is the exact inverse — which is why neither
//    column may be derived from the other.
//
//  * The heading and footer name the layer, repeatedly. The command-approval scan
//    (node-wide, armed by default) and plugin turn hooks are separate layers
//    again; a bare per-agent "Governed" badge would be read as a claim about all
//    of them.
//
//  * A row does not claim a state is IN FORCE the instant the preference write
//    returns — and the two halves are not stale for the same window. Egress is
//    injected into the spawn command, which is part of the ACP pool key, so a
//    changed value misses the warm instance and the chat's next message respawns.
//    The tool bridge is read once when the session is built and does NOT change
//    the pool key, so a chat with a live instance keeps its old tools until that
//    instance idles out. Each half carries its own `takesEffect` sentence from
//    `lib/api/agent-egress.ts`; do not collapse them into one.
//
// ── Why there is no live "is this agent running?" state here ──────────────────
// Because Core does not serve one, not because it could not. The live instances
// are `acp_pool()` in `apps/core/src/sidecar/adapters/acp.rs`: a private `fn`
// over a `HashMap` keyed `{conversation}\u{1}{agent}\u{1}{spawn_cmd}\u{1}{cwd}`.
// That key already encodes the spawn command an instance is running with, so Core
// can answer the exact question this badge wants — "is there a live instance for
// agent X whose spawn command disagrees with what today's preferences would
// produce?" — from data it already holds. Nothing reachable from the desktop
// exposes it: no `/api/agents` field, and `/api/sidecar/status` serves
// `SidecarManager::statuses()`, which enumerates the registered engine/system
// sidecars plus manifest-declared ones — an ACP agent is spawned by
// `run_acp_instance` and never registered with that manager, so it cannot appear
// there. The ask, if this is ever
// worth sharpening, is one additive field per agent on `GET /api/agents`
// (live instance count + whether its spawn command is the current one), after
// which `describeEgressBadge` can return the in-force state instead of hedging.
// The tool half wants a second field from the same place — whether the live
// instance was built WITH the bridge — for the same reason.

import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Skeleton } from "@ryu/ui/components/skeleton.tsx";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import {
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import {
	applyToolBridgePlan,
	loadAgentEgress,
	planEnableToolsForAll,
	type ToolBridgePlan,
} from "@/src/lib/api/agent-egress.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import { ToolsPlanPreview } from "./AgentEgressSection-plan-preview.tsx";
import { EgressRow } from "./AgentEgressSection-row.tsx";

/**
 * Per-agent tool access and model-egress governance. Reads only existing Core
 * endpoints (`/api/agents`, `/api/agents/:id`, `/api/agents/catalog`,
 * `/api/preferences`, `/api/pi-config`) — no new route.
 */
export function AgentEgressSection({ target }: { target: ApiTarget }) {
	const tl = useLiteralMessages();
	const query = useQuery({
		queryKey: ["agent-egress", target.url],
		queryFn: () => loadAgentEgress(target),
		staleTime: 15_000,
		refetchOnWindowFocus: false,
	});

	const view = query.data ?? null;
	const [plan, setPlan] = useState<ToolBridgePlan | null>(null);
	const [busy, setBusy] = useState(false);
	const [planError, setPlanError] = useState<string | null>(null);
	const [applied, setApplied] = useState<number | null>(null);

	const apply = async () => {
		if (!plan) {
			return;
		}
		setBusy(true);
		setPlanError(null);
		const ok = await applyToolBridgePlan(target, plan).catch(() => false);
		setBusy(false);
		if (!ok) {
			setPlanError("Could not save that. The node still has the old settings.");
			return;
		}
		setApplied(plan.changes.length);
		setPlan(null);
		query.refetch().catch(() => undefined);
	};

	// Counted, not asserted, and the terms PARTITION the rows below — a summary
	// whose numbers do not add up to its own list invites the reader to assume
	// the unaccounted rows were fine. "Pointed at it" stays out of the governed
	// count: Ryu sets OPENAI_BASE_URL but cannot make a third-party binary read it.
	//
	// TWO sentences of counts, never added together: an agent can perfectly well
	// have Ryu's tools and still talk to its provider directly, so a single total
	// would be a number with no referent.
	const caption = view
		? `Tools: ${view.toolsOnCount} have Ryu's tools · ${view.toolsOffCount} do not · ${view.toolsOtherCount} not applicable. ` +
			`Model traffic: ${view.governedCount} through the gateway · ${view.bestEffortCount} pointed at it · ${view.directCount} straight to the provider · ${view.otherCount} local or unknown. ` +
			"Only calls that reach the gateway are filtered by the rules above, counted against your spending limits, or recorded in the activity log. " +
			"These are the only two layers shown here. Command approval above is node-wide, and plugin hooks are a separate layer again."
		: "What each agent can reach: Ryu's tools, and whether its model calls pass through this gateway.";

	return (
		<SettingsSection caption={caption} title="Agent tools and model traffic">
			{query.isLoading ? (
				<SettingsGroup>
					<SettingsItem
						actions={<Skeleton className="h-5 w-32" />}
						title={<Skeleton className="h-4 w-24" />}
					/>
				</SettingsGroup>
			) : null}
			{query.isError ? (
				<div className="flex flex-wrap items-center gap-2 px-3">
					<p className="text-sm text-status-destructive" role="alert">
						Could not read this node's agent settings, so nothing is shown.
						Retry to load the current policy.
					</p>
					<Button
						disabled={query.isFetching}
						onClick={() => {
							void query.refetch();
						}}
						size="sm"
						variant="outline"
					>
						Retry
					</Button>
				</div>
			) : null}
			{view && view.rows.length > 0 ? (
				<SettingsGroup>
					{/* The one-click action sits above the list it describes, and only
					    ever covers the tools half — see `planEnableToolsForAll`. */}
					<SettingsItem
						actions={
							plan ? null : (
								<Button
									onClick={() => {
										setApplied(null);
										setPlanError(null);
										setPlan(planEnableToolsForAll(view));
									}}
									size="sm"
									variant="secondary"
								>
									Review changes
								</Button>
							)
						}
						title="Give every agent Ryu's tools"
					>
						{plan ? (
							<ToolsPlanPreview
								busy={busy}
								error={planError}
								onApply={() => {
									apply().catch(() => undefined);
								}}
								onCancel={() => setPlan(null)}
								plan={plan}
							/>
						) : (
							<p className="text-muted-foreground text-xs leading-snug">
								{applied === null
									? "Turns the tool bridge on for every agent that can take it. Shows you exactly what it will change first, and never touches model traffic."
									: tl(
											"Turned Ryu's tools on for {applied, plural, one {# agent} other {# agents}}. New chats have them now; a chat you are already in keeps its current tools until it has been idle about ten minutes.",
											{ applied }
										)}
							</p>
						)}
					</SettingsItem>
					{view.rows.map((row) => (
						<EgressRow
							key={row.agentId}
							onChanged={() => {
								query.refetch().catch(() => undefined);
							}}
							row={row}
							target={target}
						/>
					))}
				</SettingsGroup>
			) : null}
			{view && view.rows.length === 0 ? (
				<p className="px-3 text-muted-foreground text-sm">
					No agents are installed on this node yet.
				</p>
			) : null}
		</SettingsSection>
	);
}
