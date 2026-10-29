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

import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { Skeleton } from "@ryu/ui/components/skeleton.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import {
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import {
	type AgentEgress,
	applyToolBridgePlan,
	describeEgressBadge,
	describeToolBadge,
	type EgressBadgeDescriptor,
	loadAgentEgress,
	planEnableToolsForAll,
	setAgentEgressGoverned,
	setAgentToolsEnabled,
	type ToolBridgePlan,
} from "@/src/lib/api/agent-egress.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";

/**
 * One half of a row: a labelled concern with its own badge, switch, explanation
 * and timing caveat.
 *
 * Extracted so the two halves are literally the same component with different
 * data. If the tools half and the egress half ever need to look different, that
 * is a signal one of them is being demoted to a footnote — which is how the
 * conflation gets back in through the design rather than the code.
 */
function ConcernRow({
	badge,
	detail,
	error,
	hasControl,
	label,
	notes,
	onToggle,
	switchLabel,
	takesEffect,
	value,
}: {
	badge: EgressBadgeDescriptor;
	detail: string;
	error: string | null;
	hasControl: boolean;
	label: string;
	notes: string | null;
	onToggle: (next: boolean) => void;
	switchLabel: string;
	takesEffect: string | null;
	value: boolean;
}) {
	return (
		<div className="flex w-full items-start justify-between gap-3">
			<div className="flex min-w-0 flex-1 flex-col gap-0.5">
				<p className="font-medium text-foreground text-xs">{label}</p>
				<p className="text-muted-foreground text-xs leading-snug">
					{detail}
					{/* The credential note answers "what changes when routing is on?", so it
					    sits on the row itself rather than behind a docs link. */}
					{notes ? ` ${notes}` : null}
				</p>
				{/* The timing caveat is on the half PERMANENTLY, not only after this
				    panel writes it: the same preferences are writable from the agent
				    editor, so a value that arrived from the node is no more proven to
				    be in force than one we just saved. It only brightens out of the
				    muted body text in the case we can prove — right after our own
				    write, when the badge is also hedging. */}
				{takesEffect ? (
					<p
						className={
							badge.pendingStart
								? "text-foreground text-xs leading-snug"
								: "text-muted-foreground text-xs leading-snug"
						}
					>
						{takesEffect}
					</p>
				) : null}
				{error ? (
					<p className="text-status-destructive text-xs leading-snug">
						{error}
					</p>
				) : null}
			</div>
			<div className="flex shrink-0 items-center gap-2">
				<Badge variant={badge.variant}>{badge.label}</Badge>
				{hasControl ? (
					<Switch
						aria-label={switchLabel}
						checked={value}
						onCheckedChange={onToggle}
					/>
				) : null}
			</div>
		</div>
	);
}

/**
 * Per-half optimistic write state.
 *
 * `pending` is the in-flight value so the switch responds immediately; `saved` is
 * the value this panel last PERSISTED, kept for the life of the panel. `saved`
 * must be the written value rather than a bare "dirty" flag for two reasons: it
 * names which way the pending badge is going, and it holds the switch steady
 * across the gap between clearing `pending` and the refetch landing (until then
 * the row is still the pre-write read, so a switch derived only from it visibly
 * flips back).
 *
 * One of these PER HALF, never one shared: a failed tools write must not make the
 * egress badge hedge, and vice versa.
 */
interface WriteState {
	error: string | null;
	pending: boolean | null;
	saved: boolean | null;
}

const IDLE: WriteState = { pending: null, saved: null, error: null };

function EgressRow({
	row,
	target,
	onChanged,
}: {
	onChanged: () => void;
	row: AgentEgress;
	target: ApiTarget;
}) {
	const [egress, setEgress] = useState<WriteState>(IDLE);
	const [tools, setTools] = useState<WriteState>(IDLE);

	const egressChecked = egress.pending ?? egress.saved ?? row.governed === true;
	const toolsChecked =
		tools.pending ?? tools.saved ?? row.tools.enabled === true;

	/**
	 * Shared write path for both halves. The ORDER inside is load-bearing:
	 * `saved` is what makes a badge hedge, so setting it on a write that did not
	 * land would print a pending change next to "could not save" — a fresh
	 * instance of the very bug this pending state exists to remove.
	 */
	const write = async (
		set: (next: WriteState) => void,
		next: boolean,
		persist: () => Promise<boolean>
	) => {
		set({ pending: next, saved: null, error: null });
		const ok = await persist().catch(() => false);
		if (!ok) {
			set({
				pending: null,
				saved: null,
				error: "Could not save that. The node still has the old setting.",
			});
			return;
		}
		set({ pending: null, saved: next, error: null });
		onChanged();
	};

	const toolControl = row.tools.control;
	const egressControl = row.control;

	return (
		<SettingsItem title={row.name}>
			{/* Tools FIRST. It is the half that is on by default, the half a user is
			    looking for when an agent "does nothing", and the half with no
			    credential consequence — leading with egress would put the riskiest
			    switch under the reader's thumb. */}
			<ConcernRow
				badge={describeToolBadge(row, tools.saved)}
				detail={row.tools.detail}
				error={tools.error}
				hasControl={toolControl !== null}
				label="Ryu tools"
				notes={null}
				onToggle={(next) => {
					if (toolControl) {
						write(setTools, next, () =>
							setAgentToolsEnabled(target, toolControl.agentId, next)
						).catch(() => undefined);
					}
				}}
				switchLabel={`Give ${row.name} access to Ryu's tools`}
				takesEffect={row.tools.takesEffect}
				value={toolsChecked}
			/>
			<ConcernRow
				badge={describeEgressBadge(row, egress.saved)}
				detail={row.detail}
				error={egress.error}
				hasControl={egressControl !== null}
				label="Model traffic"
				notes={row.credentialNote}
				onToggle={(next) => {
					if (egressControl) {
						write(setEgress, next, () =>
							setAgentEgressGoverned(target, egressControl, next)
						).catch(() => undefined);
					}
				}}
				switchLabel={`Send ${row.name}'s model calls through the gateway`}
				takesEffect={row.takesEffect}
				value={egressChecked}
			/>
		</SettingsItem>
	);
}

/**
 * The confirmation for the bulk action: the exact per-agent list, before
 * anything is written.
 *
 * Rendered INLINE rather than as a modal — this panel already lives inside the
 * Gateway dialog, and a dialog over a dialog is both a focus-trap problem and a
 * way to hide the list behind a scrim the user dismisses to get back to the row
 * they were reading.
 *
 * Every part of this is a refusal to let a one-click action be blind: the changes
 * are named, the skips are named WITH their reason (the flagship and bare
 * `acp:pi` are the ones most worth reading), and the fact that model traffic is
 * untouched is stated rather than implied by its absence.
 */
function ToolsPlanPreview({
	busy,
	error,
	onApply,
	onCancel,
	plan,
}: {
	busy: boolean;
	error: string | null;
	onApply: () => void;
	onCancel: () => void;
	plan: ToolBridgePlan;
}) {
	return (
		<div className="flex w-full flex-col gap-2 rounded-md border border-border bg-muted/40 p-3">
			{plan.changes.length === 0 ? (
				<p className="text-muted-foreground text-xs leading-snug">
					Nothing to change. Every agent that can take Ryu's tools already has
					them.
				</p>
			) : (
				<>
					<p className="font-medium text-foreground text-xs">
						Will turn Ryu's tools on for {plan.changes.length}{" "}
						{plan.changes.length === 1 ? "agent" : "agents"}:
					</p>
					<ul className="flex flex-col gap-0.5">
						{plan.changes.map((change) => (
							<li
								className="text-muted-foreground text-xs leading-snug"
								key={change.agentId}
							>
								{change.name} — off → on
							</li>
						))}
					</ul>
				</>
			)}
			{plan.skipped.length > 0 ? (
				<>
					<p className="font-medium text-foreground text-xs">
						Leaves {plan.skipped.length}{" "}
						{plan.skipped.length === 1 ? "agent" : "agents"} alone:
					</p>
					<ul className="flex flex-col gap-0.5">
						{plan.skipped.map((skip) => (
							<li
								className="text-muted-foreground text-xs leading-snug"
								key={skip.agentId}
							>
								{skip.name} — {skip.reason}
							</li>
						))}
					</ul>
				</>
			) : null}
			{/* Stated, not implied. A "configure every agent" button that quietly
			    re-pointed a Claude Pro sign-in at the gateway and moved where that
			    spend is counted would be a serious misstep; saying what it does NOT
			    do is what makes the click safe to make. */}
			{plan.egressUntouched ? (
				<p className="text-muted-foreground text-xs leading-snug">
					Model traffic is not changed for any agent. Routing a subscription
					through the gateway moves where that credential goes and where the
					spend is counted, so it stays a per-agent choice you make on the row
					itself.
				</p>
			) : null}
			{error ? (
				<p className="text-status-destructive text-xs leading-snug">{error}</p>
			) : null}
			<div className="flex items-center gap-2">
				<Button
					disabled={busy || plan.changes.length === 0}
					onClick={onApply}
					size="sm"
				>
					{busy ? "Applying…" : "Turn tools on"}
				</Button>
				<Button
					disabled={busy}
					onClick={onCancel}
					size="sm"
					variant="secondary"
				>
					Cancel
				</Button>
			</div>
		</div>
	);
}

/**
 * Per-agent tool access and model-egress governance. Reads only existing Core
 * endpoints (`/api/agents`, `/api/agents/:id`, `/api/agents/catalog`,
 * `/api/preferences`, `/api/pi-config`) — no new route.
 */
export function AgentEgressSection({ target }: { target: ApiTarget }) {
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
				<div className="flex flex-wrap items-center gap-2 px-3.5">
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
									: `Turned Ryu's tools on for ${applied} ${applied === 1 ? "agent" : "agents"}. New chats have them now; a chat you are already in keeps its current tools until it has been idle about ten minutes.`}
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
				<p className="px-3.5 text-muted-foreground text-sm">
					No agents are installed on this node yet.
				</p>
			) : null}
		</SettingsSection>
	);
}
