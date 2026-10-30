import { Search01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { usageProviderLabel } from "@ryu/blocks/desktop/usage-analytics.ts";
import { Input } from "@ryu/ui/components/input.tsx";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import {
	SettingsCard,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import type { AuditEntry } from "@/src/lib/api/gateway.ts";
import { formatTime } from "@/src/lib/timezone.ts";
import {
	formatCost,
	formatScore,
	type ObservabilityFilter,
	type ObservabilityWindow,
	promptCacheStatus,
} from "./AgentObservabilityView-audit.ts";
import observabilityStyles from "./agent-observability.module.css";

export interface ObservabilityTraceExplorerProps {
	filter: ObservabilityFilter;
	loading: boolean;
	query: string;
	selectedId: string | null;
	setFilter: (value: ObservabilityFilter) => void;
	setQuery: (value: string) => void;
	setSelectedId: (value: string) => void;
	setTimeRange: (value: ObservabilityWindow) => void;
	timeRange: ObservabilityWindow;
	visibleEntries: AuditEntry[];
}

export function ObservabilityExplorerSection({
	filter,
	loading,
	query,
	selectedId,
	setFilter,
	setQuery,
	setSelectedId,
	setTimeRange,
	timeRange,
	visibleEntries,
}: ObservabilityTraceExplorerProps) {
	return (
		<SettingsSection
			caption="Select a row to inspect its correlated trace."
			title="Trace explorer"
		>
			<SettingsCard className="flex flex-col gap-3">
				<div className="flex flex-col gap-2 sm:flex-row">
					<div className="relative min-w-0 flex-1">
						<HugeiconsIcon
							className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
							icon={Search01Icon}
						/>
						<Input
							aria-label="Search observability"
							data-testid="observability-search"
							leadingAdornment="compact"
							onChange={(event) => setQuery(event.target.value)}
							placeholder="Search model, provider, request id, or error"
							tone="observability-foreground"
							value={query}
						/>
					</div>
					<div className="flex w-full gap-2 sm:w-auto">
						<NativeSelect
							aria-label="Observability filter"
							className="min-w-0 flex-1 sm:w-40"
							onChange={(event) =>
								setFilter(
									/* SAFETY: This authored NativeSelect offers only all, errors, slow, model and tool, the ObservabilityFilter alternatives. It does not decode arbitrary synthetic events. */ event
										.target.value as ObservabilityFilter
								)
							}
							value={filter}
						>
							<NativeSelectOption value="all">All events</NativeSelectOption>
							<NativeSelectOption value="errors">
								Errors only
							</NativeSelectOption>
							<NativeSelectOption value="slow">Slow &gt; 1s</NativeSelectOption>
							<NativeSelectOption value="model">Model calls</NativeSelectOption>
							<NativeSelectOption value="tool">Tool calls</NativeSelectOption>
						</NativeSelect>
						<NativeSelect
							aria-label="Observability window"
							className="min-w-0 flex-1 sm:w-40"
							onChange={(event) =>
								setTimeRange(
									/* SAFETY: This authored NativeSelect offers only 1h, 24h, 7d and all, the ObservabilityWindow alternatives. It does not decode arbitrary synthetic events. */ event
										.target.value as ObservabilityWindow
								)
							}
							value={timeRange}
						>
							<NativeSelectOption value="1h">Last hour</NativeSelectOption>
							<NativeSelectOption value="24h">Last 24 hours</NativeSelectOption>
							<NativeSelectOption value="7d">Last 7 days</NativeSelectOption>
							<NativeSelectOption value="all">All available</NativeSelectOption>
						</NativeSelect>
					</div>
				</div>

				{visibleEntries.length === 0 ? (
					<p className="py-6 text-center text-detail text-muted-foreground">
						{loading ? "Loading trace events…" : "No events match this view."}
					</p>
				) : (
					<div data-testid="observability-events">
						<div className="grid h-8 grid-cols-[minmax(0,1fr)_4rem_4rem_4rem] items-center gap-3 border-border border-b px-2 text-muted-foreground text-xs">
							<span>Event</span>
							<span className="text-right">Latency</span>
							<span className="text-right">Quality</span>
							<span className="text-right">Cost</span>
						</div>
						{visibleEntries.map((entry) => {
							const active = selectedId === entry.id;
							const cacheStatus = promptCacheStatus(entry);
							return (
								<button
									aria-pressed={active}
									className={cn(
										"grid h-10 w-full grid-cols-[minmax(0,1fr)_4rem_4rem_4rem] items-center gap-3 rounded-lg px-2 text-left text-sm transition-colors duration-150 hover:duration-0",
										observabilityStyles.foreground,
										"hover:bg-muted",
										active && "bg-accent"
									)}
									data-testid={`observability-event-${entry.id}`}
									key={entry.id}
									onClick={() => setSelectedId(entry.id)}
									type="button"
								>
									<span className="flex min-w-0 items-center gap-2">
										<span
											className={cn(
												"size-1.5 shrink-0 rounded-full",
												entry.error
													? "bg-status-destructive"
													: "bg-status-success"
											)}
										/>
										<span className="min-w-0 truncate font-medium">
											{entry.model ??
												entry.command ??
												entry.event_type ??
												"event"}
										</span>
										<span className="hidden shrink-0 text-muted-foreground text-xs sm:inline">
											{entry.provider
												? usageProviderLabel(entry.provider)
												: (entry.event_type ?? "event")}
										</span>
										{cacheStatus ? (
											<span
												className="shrink-0 text-muted-foreground text-xs"
												data-testid={`prompt-cache-status-${entry.id}`}
											>
												{cacheStatus}
											</span>
										) : null}
										<span className="hidden shrink-0 text-muted-foreground/70 text-xs tabular-nums md:inline">
											{formatTime(entry.timestamp)}
										</span>
									</span>
									<span className="whitespace-nowrap text-right text-muted-foreground tabular-nums">
										{entry.latency_ms === null ? "—" : `${entry.latency_ms}ms`}
									</span>
									<span className="text-right tabular-nums">
										{formatScore(entry.eval_score)}
									</span>
									<span className="whitespace-nowrap text-right text-muted-foreground tabular-nums">
										{formatCost(entry.cost_micro_usd ?? 0)}
									</span>
								</button>
							);
						})}
					</div>
				)}
			</SettingsCard>
		</SettingsSection>
	);
}
