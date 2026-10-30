import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import type { CSSProperties } from "react";
import {
	SettingsCard,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import type { AuditEntry } from "@/src/lib/api/gateway.ts";
import {
	type DiscoverGroup,
	type ObservabilityFilter,
	type ObservabilityWindow,
	type SavedObservabilityView,
	windowLabel,
} from "./AgentObservabilityView-audit.ts";
import observabilityStyles from "./agent-observability.module.css";

interface ObservabilityShareStyle extends CSSProperties {
	"--observability-share": string;
}

export interface ObservabilityDiscoverSectionProps {
	deleteView: (id: string) => void;
	discoveredGroups: DiscoverGroup[];
	entries: AuditEntry[];
	savedViews: SavedObservabilityView[];
	saveView: () => void;
	setFilter: (value: ObservabilityFilter) => void;
	setQuery: (value: string) => void;
	setTimeRange: (value: ObservabilityWindow) => void;
	setViewName: (value: string) => void;
	timeRange: ObservabilityWindow;
	viewName: string;
}

export function ObservabilityDiscoverSection({
	deleteView,
	discoveredGroups,
	entries,
	saveView,
	savedViews,
	setFilter,
	setQuery,
	setTimeRange,
	setViewName,
	timeRange,
	viewName,
}: ObservabilityDiscoverSectionProps) {
	const tl = useLiteralMessages();
	return (
		<SettingsSection
			caption="Failure patterns and model facets. Saved views stay on this device."
			title="Discover"
		>
			<SettingsCard
				className="flex flex-col gap-3"
				data-testid="observability-discover"
			>
				<div className="flex flex-col gap-2 sm:flex-row">
					<Input
						aria-label="Saved observability view name"
						className="min-w-0 flex-1"
						onChange={(event) => setViewName(event.target.value)}
						placeholder="Name this view, e.g. Checkout failures"
						value={viewName}
					/>
					<Button
						disabled={!viewName.trim()}
						onClick={saveView}
						variant="outline"
					>
						Save current view
					</Button>
				</div>
				{savedViews.length > 0 ? (
					<div className="flex flex-wrap gap-2">
						{savedViews.map((view) => (
							<div className="flex items-center gap-0.5" key={view.id}>
								<Button
									onClick={() => {
										setFilter(view.filter);
										setQuery(view.query);
										setTimeRange(view.timeRange);
									}}
									size="sm"
									variant="ghost"
								>
									{view.name}
								</Button>
								<Button
									aria-label={tl("Remove saved view {name}", {
										name: view.name,
									})}
									onClick={() => deleteView(view.id)}
									size="icon-sm"
									variant="ghost-muted"
								>
									<HugeiconsIcon className="size-3.5" icon={Cancel01Icon} />
								</Button>
							</div>
						))}
					</div>
				) : null}
				<div className="flex flex-col gap-2">
					<div className="flex items-center justify-between gap-2">
						<span className="font-semibold text-sm">Top patterns</span>
						<span className="text-muted-foreground/70 text-xs tabular-nums">
							{tl("{count} events in {window}", {
								count: String(entries.length),
								window: windowLabel(timeRange).toLowerCase(),
							})}
						</span>
					</div>
					{discoveredGroups.length === 0 ? (
						<p className="py-4 text-center text-detail text-muted-foreground">
							No patterns to discover yet.
						</p>
					) : (
						<div className="flex flex-col gap-2">
							{discoveredGroups.map((group) => {
								const shareGeometry: ObservabilityShareStyle = {
									"--observability-share": `${Math.max(4, group.percent * 100)}%`,
								};
								return (
									<div className="flex flex-col gap-1" key={group.key}>
										<div className="flex items-center justify-between gap-2 text-sm">
											<span
												className="min-w-0 truncate font-medium"
												title={group.key}
											>
												{group.key}
											</span>
											<span className="shrink-0 text-muted-foreground text-xs tabular-nums">
												{group.count} · {Math.round(group.percent * 100)}%
											</span>
										</div>
										<div className="h-1.5 overflow-hidden rounded-full bg-muted">
											<div
												className={cn(
													observabilityStyles.share,
													"h-full rounded-full",
													group.errorCount > 0
														? "bg-status-destructive"
														: "bg-primary"
												)}
												style={shareGeometry}
											/>
										</div>
										<div className="flex gap-2 text-muted-foreground/70 text-xs tabular-nums">
											{group.errorCount > 0 ? (
												<span>
													{tl("{count} errors", {
														count: String(group.errorCount),
													})}
												</span>
											) : null}
											<span>
												{tl("avg {latency}", {
													latency:
														group.averageLatency === null
															? "—"
															: `${Math.round(group.averageLatency)}ms`,
												})}
											</span>
										</div>
									</div>
								);
							})}
						</div>
					)}
				</div>
			</SettingsCard>
		</SettingsSection>
	);
}
