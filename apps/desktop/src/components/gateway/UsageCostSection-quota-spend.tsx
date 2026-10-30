// Usage & Cost: provider quota countdowns and per-model spend cards.

import { Button } from "@ryu/ui/components/button.tsx";
import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@ryu/ui/components/table.tsx";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { CaptionInfo, StatusText } from "@/src/components/gateway/quiet.tsx";
import {
	SettingsCard,
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import type { GatewayMetrics, ProviderQuota } from "@/src/lib/api/gateway.ts";
import { fetchProfileStats } from "@/src/lib/api/profile.ts";
import {
	formatCost,
	formatCountdown,
	formatNumber,
	formatQuota,
	providerLabel,
	TICK_MS,
} from "./UsageCostSection-format.ts";

// ── 1. Provider quota countdowns ─────────────────────────────────────────────

const HEAD = "h-10 px-2 font-normal text-muted-foreground text-xs";
const CELL = "h-10 px-2 py-0";

/**
 * Live seconds remaining for a quota window: the snapshot's `resetInSecs`
 * decremented by the wall-clock time elapsed since the snapshot arrived, so the
 * value keeps ticking down smoothly between the parent's 5s status polls.
 */
function liveResetSecs(
	quota: ProviderQuota,
	elapsedSecs: number
): number | null {
	if (quota.resetInSecs === null) {
		return null;
	}
	return Math.max(0, quota.resetInSecs - elapsedSecs);
}

export function ProviderQuotaCard({
	metrics,
}: {
	metrics: GatewayMetrics | null;
}) {
	const [nowMs, setNowMs] = useState(() => Date.now());
	const receivedAtRef = useRef(Date.now());

	// Reset the elapsed clock whenever a fresh metrics snapshot arrives.
	useEffect(() => {
		receivedAtRef.current = Date.now();
		setNowMs(Date.now());
	}, [metrics]);

	// Local 1s ticker to advance the countdown between polls; cleaned up on unmount.
	useEffect(() => {
		const id = setInterval(() => setNowMs(Date.now()), TICK_MS);
		return () => clearInterval(id);
	}, []);

	const quota = metrics?.providerQuota ?? {};
	const entries = Object.entries(quota).sort(([a], [b]) => a.localeCompare(b));
	const elapsedSecs = Math.max(
		0,
		Math.floor((nowMs - receivedAtRef.current) / TICK_MS)
	);

	return (
		<SettingsSection
			caption={
				<CaptionInfo
					detail={
						"The countdown ticks down between polls; a provider only appears after its quota headers have been seen once."
					}
				>
					{"Rate-limit windows reported by each provider."}
				</CaptionInfo>
			}
			title="Provider quota"
		>
			{entries.length === 0 ? (
				<p className="py-3 text-muted-foreground text-sm">
					Quota appears here once providers report their limits.
				</p>
			) : (
				<Table className="text-sm">
					<TableHeader>
						<TableRow appearance="header">
							<TableHead className={HEAD}>Provider</TableHead>
							<TableHead className={HEAD}>Remaining / Limit</TableHead>
							<TableHead className={HEAD}>Resets in</TableHead>
							<TableHead className={HEAD}>Status</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{entries.map(([name, q]) => {
							const secs = liveResetSecs(q, elapsedSecs);
							return (
								<TableRow className="border-border" key={name}>
									<TableCell className={CELL}>{providerLabel(name)}</TableCell>
									<TableCell className={`${CELL} tabular-nums`}>
										{formatQuota(q)}
									</TableCell>
									<TableCell className={`${CELL} tabular-nums`}>
										{formatCountdown(secs)}
									</TableCell>
									<TableCell className={CELL}>
										{q.rateLimited ? (
											<StatusText tone="destructive">Rate limited</StatusText>
										) : null}
									</TableCell>
								</TableRow>
							);
						})}
					</TableBody>
				</Table>
			)}
		</SettingsSection>
	);
}

// ── 2. Per-model spend ───────────────────────────────────────────────────────

export function ModelSpendCard() {
	const { data, isLoading, isError, error, refetch } = useQuery({
		queryKey: ["profile", "stats"],
		queryFn: fetchProfileStats,
	});

	const renderBody = () => {
		if (isLoading) {
			return (
				<SettingsCard>
					<SkeletonRows label="Loading…" spacing="budget" />
				</SettingsCard>
			);
		}
		if (isError || !data) {
			const requiresSignIn =
				error instanceof Error &&
				error.message === "Sign in to view your stats.";
			return (
				<SettingsItem
					actions={
						requiresSignIn ? null : (
							<Button
								aria-label="Retry account usage rollup"
								onClick={() => void refetch()}
								size="sm"
								variant="outline"
							>
								Retry
							</Button>
						)
					}
					title={
						<span className="text-muted-foreground">
							{error instanceof Error
								? error.message
								: "Sign in to view your usage and spend."}
						</span>
					}
				/>
			);
		}
		const totalTokens = data.totals.inputTokens + data.totals.outputTokens;
		const topModels = data.insights.topModels;
		return (
			<>
				<SettingsGroup>
					<MetricRow
						label="Total spend"
						value={formatCost(data.totals.costMicroUsd)}
					/>
					<MetricRow
						label="Requests"
						value={formatNumber(data.totals.requestCount)}
					/>
					<MetricRow label="Tokens" value={formatNumber(totalTokens)} />
				</SettingsGroup>
				{topModels.length === 0 ? (
					<SettingsCard className="py-3 text-muted-foreground text-sm">
						No model usage recorded yet.
					</SettingsCard>
				) : (
					<SettingsCard className="overflow-x-auto py-2">
						<table className="w-full text-sm">
							<thead>
								<tr className="border-border border-b text-left text-muted-foreground text-xs">
									<th className="pr-3 pb-2 font-medium">Model</th>
									<th className="pb-2 text-right font-medium">Requests</th>
								</tr>
							</thead>
							<tbody>
								{topModels.map((m) => (
									<tr
										className="border-border border-b last:border-0"
										key={m.id}
									>
										<td className="py-2 pr-3 font-mono text-xs">{m.id}</td>
										<td className="py-2 text-right text-xs tabular-nums">
											{formatNumber(m.count)}
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</SettingsCard>
				)}
			</>
		);
	};

	return (
		<SettingsSection
			caption={
				<CaptionInfo
					detail={
						"This is the signed-in account profile rollup, not the shared organization wallet. Organization credits and managed-inference debits are shown in Credits and Usage."
					}
				>
					{"Your account's rollup, separate from the organization wallet."}
				</CaptionInfo>
			}
			title="Account usage rollup"
		>
			{renderBody()}
		</SettingsSection>
	);
}

function MetricRow({ label, value }: { label: string; value: string }) {
	return (
		<SettingsItem
			actions={
				<span className="text-muted-foreground text-sm tabular-nums">
					{value}
				</span>
			}
			title={label}
		/>
	);
}
