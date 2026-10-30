import { useLiteralMessages } from "@ryu/i18n/react";
import { CaptionInfo } from "@/src/components/gateway/quiet.tsx";
import {
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import type { GatewayMetrics } from "@/src/lib/api/gateway.ts";
import { CircuitStatus, formatNumber } from "./shared.tsx";

export function ProvidersCard({
	providers,
	metrics,
}: {
	providers: string[];
	metrics: GatewayMetrics | null;
}) {
	const tl = useLiteralMessages();
	const requestCounts = metrics?.providers.requests ?? {};
	const errorCounts = metrics?.providers.errors ?? {};
	const healthMap = metrics?.providerHealth ?? {};

	return (
		<SettingsSection
			caption={
				<CaptionInfo
					detail={"A provider shows Open when its circuit breaker trips."}
				>
					{"Providers the gateway can route to, with request and error counts."}
				</CaptionInfo>
			}
			title="Providers"
		>
			{providers.length === 0 ? (
				<p className="py-3 text-muted-foreground text-sm">
					No providers reported yet.
				</p>
			) : (
				<SettingsGroup>
					{providers.map((name) => {
						const health = healthMap[name];
						return (
							<SettingsItem
								actions={
									<span className="flex items-center gap-3 text-muted-foreground text-sm tabular-nums">
										<CircuitStatus state={health} />
										{(errorCounts[name] ?? 0) > 0 ? (
											<span className="text-status-destructive">
												{tl("{count} errors", {
													count: formatNumber(errorCounts[name] ?? 0),
												})}
											</span>
										) : null}
										<span>
											{tl("{count} requests", {
												count: formatNumber(requestCounts[name] ?? 0),
											})}
										</span>
									</span>
								}
								key={name}
								title={name}
							/>
						);
					})}
				</SettingsGroup>
			)}
		</SettingsSection>
	);
}
