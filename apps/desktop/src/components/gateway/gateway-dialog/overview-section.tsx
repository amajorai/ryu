import { useLiteralMessages } from "@ryu/i18n/react";
import { GatewayPostureCard } from "@/src/components/gateway/GatewayPostureCard.tsx";
import {
	Disclosure,
	StatGrid,
	StatusText,
} from "@/src/components/gateway/quiet.tsx";
import {
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import type { GatewayMetrics, GatewayStatus } from "@/src/lib/api/gateway.ts";
import { ProvidersCard } from "./providers-card.tsx";
import { formatNumber, formatPercent, MetricTile } from "./shared.tsx";

/** Health + metrics observability block, shown on the Overview tab. */
export function OverviewSection({
	canConfigure,
	reachable,
	status,
	metrics,
	target,
}: {
	canConfigure: boolean;
	reachable: boolean;
	status: GatewayStatus | null;
	metrics: GatewayMetrics | null;
	target: ApiTarget;
}) {
	const tl = useLiteralMessages();
	if (!reachable) {
		return (
			<SettingsSection title="Gateway unreachable">
				<p className="text-muted-foreground text-sm">
					{status?.url
						? tl(
								"Core couldn't reach a healthy gateway at {url}. Start it, then refresh.",
								{ url: status.url }
							)
						: tl(
								"Core couldn't reach a healthy gateway. Start it, then refresh."
							)}
				</p>
			</SettingsSection>
		);
	}

	const h = status?.health ?? null;
	const providerCount = h?.providers.length ?? 0;

	return (
		<>
			<GatewayPostureCard
				canConfigure={canConfigure}
				reachable={reachable}
				target={target}
			/>
			<SettingsSection
				caption={`${status?.url ?? "gateway"}${h?.version ? ` · v${h.version}` : ""}`}
				title="Health"
			>
				<SettingsGroup>
					<SettingsItem
						actions={
							<StatusText tone={h?.status === "ok" ? "success" : "warning"}>
								{h?.status === "ok" ? "Running" : (h?.status ?? "Unknown")}
							</StatusText>
						}
						title="Status"
					/>
					<SettingsItem
						actions={
							<span className="text-muted-foreground text-sm">
								{h?.authRequired ? "Required" : "Off"}
							</span>
						}
						title="Authentication"
					/>
					<SettingsItem
						actions={
							<span className="text-muted-foreground text-sm tabular-nums">
								{providerCount > 0
									? tl(
											"{count, plural, one {# provider} other {# providers}}",
											{
												count: providerCount,
											}
										)
									: "None yet"}
							</span>
						}
						title="Providers"
					/>
				</SettingsGroup>
			</SettingsSection>

			{metrics ? (
				<SettingsSection title="Traffic">
					<StatGrid className="py-3">
						<MetricTile
							label="Requests"
							value={formatNumber(metrics.requests.total)}
						/>
						<MetricTile
							label="Errors"
							value={formatNumber(metrics.requests.errors)}
						/>
						<MetricTile
							label="Cache hit rate"
							value={formatPercent(metrics.cache.hitRate)}
						/>
						<MetricTile
							label="Tokens in / out"
							value={`${formatNumber(metrics.tokens.input)} / ${formatNumber(metrics.tokens.output)}`}
						/>
					</StatGrid>
					{/* Cache and budget counters are secondary: one click away. */}
					<Disclosure className="mt-2">
						<p className="mt-2 font-semibold text-sm">Cache</p>
						<StatGrid className="py-3">
							<MetricTile
								label="Exact hits"
								value={formatNumber(metrics.cache.exactHits)}
							/>
							<MetricTile
								label="Semantic hits"
								value={formatNumber(metrics.cache.semanticHits)}
							/>
							<MetricTile
								label="Misses"
								value={formatNumber(metrics.cache.misses)}
							/>
						</StatGrid>
						<p className="mt-4 font-semibold text-sm">Budget & policy</p>
						<StatGrid className="py-3">
							<MetricTile
								label="Budget exceeded"
								value={formatNumber(metrics.requests.budgetExceeded)}
							/>
							<MetricTile
								label="Budget downgraded"
								value={formatNumber(metrics.requests.budgetDowngraded)}
							/>
							<MetricTile
								label="Budget restricted"
								value={formatNumber(metrics.requests.budgetRestricted)}
							/>
							<MetricTile
								label="Budget notified"
								value={formatNumber(metrics.requests.budgetNotified)}
							/>
							<MetricTile
								label="Firewall blocked"
								value={formatNumber(metrics.requests.firewallBlocked)}
							/>
							<MetricTile
								label="Rate limited"
								value={formatNumber(metrics.requests.rateLimited)}
							/>
						</StatGrid>
					</Disclosure>
				</SettingsSection>
			) : (
				<SettingsSection title="Traffic">
					<p className="text-muted-foreground text-sm">
						The gateway is running but sent no metrics yet.
					</p>
				</SettingsSection>
			)}

			<ProvidersCard metrics={metrics} providers={h?.providers ?? []} />
		</>
	);
}
