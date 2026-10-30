// Settings → Developer → "Performance". A live read of the dev-metrics ring
// buffers: what the last chat turns cost, and which Core endpoints are slow.
//
// It exists because "the chat felt slow" is unactionable and "first token took
// 9s, the stream took 400ms" is a diagnosis. The two tables split exactly along
// that line — turns first (what the user felt), then the API calls underneath.

import { Button } from "@ryu/ui/components/button.tsx";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { formatCount } from "@ryu/ui/lib/number-format.ts";
import { useSyncExternalStore } from "react";
import {
	clearDevMetrics,
	getDevMetricsRevision,
	getDevMetricsText,
	getHttpSamples,
	getTurnSamples,
	subscribeDevMetrics,
	summarizeHttp,
	summarizeTurns,
} from "@/src/lib/dev-metrics.ts";
import { formatTime } from "@/src/lib/timezone.ts";
import {
	SettingsCard,
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "./shared/settings-items.tsx";

/** Round to whole milliseconds, or seconds once the number stops being legible. */
function formatMs(value: number): string {
	if (value <= 0) {
		return "—";
	}
	return value >= 1000
		? `${(value / 1000).toFixed(1)}s`
		: `${Math.round(value)}ms`;
}

function formatBytes(value: number): string {
	if (value < 1024) {
		return `${value} B`;
	}
	if (value < 1024 * 1024) {
		return `${(value / 1024).toFixed(1)} KB`;
	}
	return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

/** One headline number with its name under it. */
function Stat({ label, value }: { label: string; value: string }) {
	return (
		<div className="flex min-w-0 flex-col gap-0.5">
			<span className="font-medium text-sm tabular-nums">{value}</span>
			<span
				className="truncate text-muted-foreground text-xs"
				data-slot="stat-label"
				title={label}
			>
				{label}
			</span>
		</div>
	);
}

export function DevMetricsPanel() {
	// Re-render on every recorded sample. The store is a plain revision counter,
	// so the snapshot is a number and React's identity check does the throttling.
	useSyncExternalStore(
		subscribeDevMetrics,
		getDevMetricsRevision,
		getDevMetricsRevision
	);

	const turns = getTurnSamples();
	const http = getHttpSamples();
	const turnStats = summarizeTurns(turns);
	const httpStats = summarizeHttp(http);
	const recentTurns = [...turns].slice(-8).reverse();

	const handleCopy = async () => {
		const text = getDevMetricsText();
		if (!text) {
			toast.error("No metrics recorded yet");
			return;
		}
		try {
			await navigator.clipboard.writeText(text);
			toast.success("Performance metrics copied to clipboard");
		} catch {
			toast.error("Couldn't copy to clipboard");
		}
	};

	return (
		<SettingsSection
			caption="Recorded in memory only, capped at 500 samples each, and never sent anywhere. They are also included in the diagnostics bundle above."
			headerAction={
				<div className="flex items-center gap-2">
					<Button onClick={handleCopy} size="sm" variant="ghost">
						Copy
					</Button>
					<Button onClick={clearDevMetrics} size="sm" variant="ghost">
						Clear
					</Button>
				</div>
			}
			title="Performance"
		>
			<SettingsGroup>
				<SettingsItem
					description="Time to first token is the wait before anything appears: queueing, routing, and the model thinking. Total is the whole turn, so total minus first token is how long the model spent writing."
					title="Chat turns"
				>
					<div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
						<Stat label="turns" value={formatCount(turnStats.count) ?? "—"} />
						<Stat
							label="first token (median)"
							value={formatMs(turnStats.medianTtft)}
						/>
						<Stat
							label="first token (p95)"
							value={formatMs(turnStats.p95Ttft)}
						/>
						<Stat
							label="total (median)"
							value={formatMs(turnStats.medianTotal)}
						/>
						<Stat label="total (p95)" value={formatMs(turnStats.p95Total)} />
					</div>
				</SettingsItem>
			</SettingsGroup>

			{recentTurns.length > 0 ? (
				<SettingsCard>
					<p className="mb-2 text-detail text-muted-foreground">Recent turns</p>
					<div className="overflow-x-auto">
						<table className="w-full text-xs">
							<thead className="text-muted-foreground">
								<tr className="text-left">
									<th className="py-1 pr-3 font-normal">Time</th>
									<th className="py-1 pr-3 font-normal">Status</th>
									<th className="py-1 pr-3 text-right font-normal">
										First token
									</th>
									<th className="py-1 pr-3 text-right font-normal">Total</th>
									<th className="py-1 pr-3 text-right font-normal">Size</th>
									<th className="py-1 text-right font-normal">Chunks</th>
								</tr>
							</thead>
							<tbody className="tabular-nums">
								{recentTurns.map((turn) => (
									<tr
										className="border-border border-t"
										key={`${turn.at}-${turn.ms}`}
									>
										<td className="py-1 pr-3">{formatTime(turn.at)}</td>
										<td className="py-1 pr-3">
											{turn.status === 0 ? "failed" : turn.status}
										</td>
										<td className="py-1 pr-3 text-right">
											{turn.ttftMs === null ? "—" : formatMs(turn.ttftMs)}
										</td>
										<td className="py-1 pr-3 text-right">
											{formatMs(turn.ms)}
										</td>
										<td className="py-1 pr-3 text-right">
											{formatBytes(turn.bytes)}
										</td>
										<td className="py-1 text-right">
											{formatCount(turn.chunks) ?? "—"}
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				</SettingsCard>
			) : null}

			<SettingsCard>
				<p className="mb-2 text-detail text-muted-foreground">
					Core API calls — slowest first
				</p>
				{httpStats.length === 0 ? (
					<p className="text-detail text-muted-foreground">
						Nothing recorded yet. Use the app for a moment and this fills in.
					</p>
				) : (
					<div className="overflow-x-auto">
						<table className="w-full text-xs">
							<thead className="text-muted-foreground">
								<tr className="text-left">
									<th className="py-1 pr-3 font-normal">Endpoint</th>
									<th className="py-1 pr-3 text-right font-normal">Calls</th>
									<th className="py-1 pr-3 text-right font-normal">Median</th>
									<th className="py-1 pr-3 text-right font-normal">p95</th>
									<th className="py-1 pr-3 text-right font-normal">Max</th>
									<th className="py-1 text-right font-normal">Errors</th>
								</tr>
							</thead>
							<tbody className="tabular-nums">
								{httpStats.slice(0, 15).map((stat) => (
									<tr className="border-border border-t" key={stat.path}>
										<td
											className="max-w-[22rem] truncate py-1 pr-3 font-mono"
											title={stat.path}
										>
											{stat.path}
										</td>
										<td className="py-1 pr-3 text-right">
											{formatCount(stat.count) ?? "—"}
										</td>
										<td className="py-1 pr-3 text-right">
											{formatMs(stat.median)}
										</td>
										<td className="py-1 pr-3 text-right">
											{formatMs(stat.p95)}
										</td>
										<td className="py-1 pr-3 text-right">
											{formatMs(stat.max)}
										</td>
										<td className="py-1 text-right">
											{stat.errors > 0 ? formatCount(stat.errors) : "—"}
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				)}
			</SettingsCard>
		</SettingsSection>
	);
}
