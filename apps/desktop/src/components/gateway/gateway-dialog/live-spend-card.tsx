import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import { useEffect, useState } from "react";
import { formatBudgetUsd } from "@/src/components/gateway/budget-copy.ts";
import { CaptionInfo } from "@/src/components/gateway/quiet.tsx";
import {
	SettingsCard,
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import type { BudgetSpend } from "@/src/lib/api/gateway.ts";
import { fetchBudgetSpend } from "@/src/lib/api/gateway.ts";

const SPEND_POLL_MS = 5000;
const MAX_SESSION_ROWS = 8;

/** One id → spent (/ limit) row list for a single spend scope, spend-sorted. */
function SpendRows({
	spend,
	limits,
	max,
	idPrefix,
}: {
	spend: Record<string, number>;
	/** Configured caps keyed by the same ids (0 / absent = unlimited). */
	limits: Record<string, number>;
	/** Cap the number of rows (ephemeral session ids can be many). */
	max?: number;
	/** Stable prefix for React keys. */
	idPrefix: string;
}) {
	const sorted = Object.entries(spend).sort(([, a], [, b]) => b - a);
	const rows = max ? sorted.slice(0, max) : sorted;
	return (
		<SettingsGroup>
			{rows.map(([id, spent]) => {
				const cap = limits[id] ?? 0;
				return (
					<SettingsItem
						actions={
							<span className="text-muted-foreground text-xs tabular-nums">
								{formatBudgetUsd(spent)}
								{cap > 0 ? ` / ${formatBudgetUsd(cap)}` : ""}
							</span>
						}
						key={`${idPrefix}-${id}`}
						title={
							<span className="truncate font-mono text-xs" title={id}>
								{id}
							</span>
						}
					/>
				);
			})}
		</SettingsGroup>
	);
}

/**
 * Live budget spend readout (M2 control-layer UX). Polls Core's proxy of the
 * gateway's in-memory per-user / per-agent / per-session charged-spend counters and
 * shows spend-vs-limit. The gateway only tracks ids with a CONFIGURED budget
 * (a session cap of 0 records nothing), so with no budget set the maps are
 * empty and this renders a hint instead of an empty pane. Counters are
 * in-memory: a gateway restart resets them.
 */
export function LiveSpendCard({ target }: { target: ApiTarget }) {
	const [spend, setSpend] = useState<BudgetSpend | null>(null);
	const [loading, setLoading] = useState(true);

	useEffect(() => {
		let cancelled = false;
		const controller = new AbortController();
		const tick = async () => {
			try {
				const next = await fetchBudgetSpend(target, {}, controller.signal);
				if (!cancelled) {
					setSpend(next);
				}
			} catch {
				// Core unreachable — leave the last snapshot; the status card owns
				// the reachability surface.
			} finally {
				if (!cancelled) {
					setLoading(false);
				}
			}
		};
		tick();
		const timer = setInterval(tick, SPEND_POLL_MS);
		return () => {
			cancelled = true;
			controller.abort();
			clearInterval(timer);
		};
	}, [target]);

	const userEntries = Object.entries(spend?.users ?? {});
	const agentEntries = Object.entries(spend?.agents ?? {});
	const sessionEntries = Object.entries(spend?.sessions ?? {});
	const anySpend =
		userEntries.length > 0 ||
		agentEntries.length > 0 ||
		sessionEntries.length > 0;
	const sessionLimit = spend?.limits.session ?? 0;

	return (
		<SettingsSection
			caption={
				<CaptionInfo
					detail={
						"Live charged spend per user, per agent, and per session, read from the gateway's in-memory counters. Only scopes with a configured budget are tracked; counters reset when the gateway restarts."
					}
				>
					{"Live spend per user, agent and session with a budget."}
				</CaptionInfo>
			}
			title="Live spend"
		>
			{loading && !spend ? (
				<SettingsCard>
					<SkeletonRows label="Loading…" spacing="budget" />
				</SettingsCard>
			) : null}
			{!loading && spend && !spend.reachable ? (
				<SettingsCard className="py-3 text-muted-foreground text-sm">
					Gateway unreachable. Live spend appears once it is running.
				</SettingsCard>
			) : null}
			{!loading && spend?.reachable && !anySpend ? (
				<SettingsCard className="py-3 text-muted-foreground text-sm">
					No spend tracked yet. Configure a budget above, then spend appears
					here as traffic flows.
				</SettingsCard>
			) : null}
			{spend?.reachable && anySpend ? (
				<div className="flex flex-col gap-4">
					{userEntries.length > 0 ? (
						<SettingsSection title="Per-user">
							<SpendRows
								idPrefix="user"
								limits={spend.limits.users}
								spend={spend.users}
							/>
						</SettingsSection>
					) : null}
					{agentEntries.length > 0 ? (
						<SettingsSection title="Per-agent">
							<SpendRows
								idPrefix="agent"
								limits={spend.limits.agents}
								spend={spend.agents}
							/>
						</SettingsSection>
					) : null}
					{sessionEntries.length > 0 ? (
						<SettingsSection title="Per-session">
							<SpendRows
								idPrefix="session"
								limits={sessionEntries.reduce<Record<string, number>>(
									(acc, [id]) => {
										acc[id] = sessionLimit;
										return acc;
									},
									{}
								)}
								max={MAX_SESSION_ROWS}
								spend={spend.sessions}
							/>
						</SettingsSection>
					) : null}
				</div>
			) : null}
		</SettingsSection>
	);
}
