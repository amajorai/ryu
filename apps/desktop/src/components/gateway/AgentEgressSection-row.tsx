// apps/desktop/src/components/gateway/AgentEgressSection-row.tsx
//
// One agent's two-half row for `AgentEgressSection.tsx`; see that file's header
// for why every row is two rows.

import { useLiteralMessages } from "@ryu/i18n/react";
import { Switch } from "@ryu/ui/components/switch.tsx";
import { useState } from "react";
import { StatusText } from "@/src/components/gateway/quiet.tsx";
import { SettingsItem } from "@/src/components/settings/shared/settings-items.tsx";
import {
	type AgentEgress,
	describeEgressBadge,
	describeToolBadge,
	type EgressBadgeDescriptor,
	setAgentEgressGoverned,
	setAgentToolsEnabled,
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
				<StatusText
					tone={
						badge.variant === "destructive"
							? "destructive"
							: badge.variant === "default"
								? "success"
								: "muted"
					}
				>
					{badge.label}
				</StatusText>
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

export function EgressRow({
	row,
	target,
	onChanged,
}: {
	onChanged: () => void;
	row: AgentEgress;
	target: ApiTarget;
}) {
	const tl = useLiteralMessages();
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
				switchLabel={tl("Give {name} access to Ryu's tools", {
					name: row.name,
				})}
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
				switchLabel={tl("Send {name}'s model calls through the gateway", {
					name: row.name,
				})}
				takesEffect={row.takesEffect}
				value={egressChecked}
			/>
		</SettingsItem>
	);
}
