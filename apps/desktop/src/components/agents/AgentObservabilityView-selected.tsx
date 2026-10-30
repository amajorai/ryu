import { useLiteralMessages } from "@ryu/i18n/react";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Textarea } from "@ryu/ui/components/textarea.tsx";
import { isNativeNumber } from "@ryu/ui/lib/native-primitive-observation.ts";
import { InlineErrorRow } from "@/src/components/chat/InlineErrorRow.tsx";
import {
	SettingsCard,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import type { AuditEntry } from "@/src/lib/api/gateway.ts";
import type { RunSpan } from "@/src/lib/api/runs.ts";
import {
	cacheMissTokens,
	formatCost,
	formatNumber,
	formatPercent,
	formatScore,
	promptCacheStatus,
} from "./AgentObservabilityView-audit.ts";
import { SummaryCard, TraceRow } from "./AgentObservabilityView-cards.tsx";

export function ObservabilitySelectedSection({
	contextWindowLoading,
	importError,
	importing,
	importMessage,
	importSelectedTrace,
	onOpenRun,
	scoreError,
	scoreOnline,
	scoreResponse,
	scoreResult,
	scoreRubric,
	scoring,
	selected,
	selectedContextWindow,
	selectedRunId,
	setScoreResponse,
	setScoreRubric,
	trace,
	traceError,
	traceLoading,
}: {
	contextWindowLoading: boolean;
	importError: string | null;
	importing: boolean;
	importMessage: string | null;
	importSelectedTrace: () => Promise<void>;
	onOpenRun?: (conversationId: string) => void;
	scoreError: string | null;
	scoreOnline: () => Promise<void>;
	scoreResponse: string;
	scoreResult: number | null;
	scoreRubric: string;
	scoring: boolean;
	selected: AuditEntry;
	selectedContextWindow: number | null;
	selectedRunId: string | null;
	setScoreResponse: (value: string) => void;
	setScoreRubric: (value: string) => void;
	trace: RunSpan[];
	traceError: string | null;
	traceLoading: boolean;
}) {
	const tl = useLiteralMessages();
	return (
		<SettingsSection
			caption="Tool inputs are stored as fingerprints. Open the conversation for the full transcript."
			title="Selected trace"
		>
			<div data-testid="observability-trace">
				<SettingsCard className="flex flex-col gap-3">
					<div className="flex flex-wrap items-start justify-between gap-3">
						<div className="min-w-0">
							<div className="flex flex-wrap items-center gap-2">
								<h3 className="font-medium text-sm">
									{selected.model ?? selected.command ?? "Trace event"}
								</h3>
								{selected.error ? (
									<Badge variant="destructive">Failed</Badge>
								) : null}
							</div>
							<p className="mt-1 break-all font-mono text-muted-foreground text-xs">
								{selected.session_id ?? selected.request_id}
							</p>
						</div>
						<div className="text-right text-xs tabular-nums">
							<p className="font-medium">
								{tl("{count} tokens", {
									count: formatNumber(
										(selected.input_tokens ?? 0) + (selected.output_tokens ?? 0)
									),
								})}
							</p>
							<p className="text-muted-foreground">
								{formatCost(selected.cost_micro_usd ?? 0)}
							</p>
						</div>
						<div className="flex flex-wrap justify-end gap-2">
							{selectedRunId ? (
								<Button
									disabled={importing}
									loading={importing}
									onClick={() => importSelectedTrace().catch(() => undefined)}
									size="sm"
									variant="outline"
								>
									Add to Quality tests
								</Button>
							) : null}
							{selectedRunId && onOpenRun ? (
								<Button
									onClick={() => onOpenRun(selectedRunId)}
									size="sm"
									variant="outline"
								>
									Open conversation
								</Button>
							) : null}
						</div>
					</div>

					{selected.error ? (
						<InlineErrorRow
							details={selected.error}
							message="This request failed."
						/>
					) : null}
					{selected.event_type === "model_call" ? (
						<div
							className="grid gap-x-6 gap-y-3 sm:grid-cols-4"
							data-testid="observability-prompt-cache"
						>
							<div>
								<p className="text-detail text-muted-foreground">
									Prompt cache
								</p>
								<p className="mt-1 font-medium text-sm">
									{promptCacheStatus(selected) ?? "Usage not reported"}
								</p>
							</div>
							<div>
								<p className="text-detail text-muted-foreground">Cache read</p>
								<p className="mt-1 font-medium text-sm tabular-nums">
									{selected.prompt_cache_read_tokens === null
										? "Unreported"
										: tl("{count} tokens", {
												count: formatNumber(selected.prompt_cache_read_tokens),
											})}
								</p>
							</div>
							<div>
								<p className="text-detail text-muted-foreground">Cache write</p>
								<p className="mt-1 font-medium text-sm tabular-nums">
									{selected.prompt_cache_write_tokens === null
										? "Unreported"
										: tl("{count} tokens", {
												count: formatNumber(selected.prompt_cache_write_tokens),
											})}
								</p>
							</div>
							<div data-testid="observability-context-window">
								<p className="text-detail text-muted-foreground">
									Context window
								</p>
								<p className="mt-1 font-medium text-sm tabular-nums">
									{selectedContextWindow === null
										? contextWindowLoading
											? "Resolving model window…"
											: "Unreported"
										: tl("{count} tokens", {
												count: formatNumber(selectedContextWindow),
											})}
								</p>
								<p className="text-muted-foreground/70 text-xs tabular-nums">
									{selected.input_tokens === null
										? "Input tokens unreported"
										: selectedContextWindow === null
											? tl("{count} input tokens", {
													count: formatNumber(selected.input_tokens),
												})
											: tl("{input} input · {share} of window", {
													input: formatNumber(selected.input_tokens),
													share: formatPercent(
														selected.input_tokens / selectedContextWindow
													),
												})}
								</p>
							</div>
						</div>
					) : null}
					{isNativeNumber(selected.cache_read_tokens) ||
					isNativeNumber(selected.cache_write_tokens) ? (
						<div
							className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3"
							data-testid="observability-cache-usage"
						>
							<SummaryCard
								label="Cache hits"
								value={
									isNativeNumber(selected.cache_read_tokens)
										? formatNumber(selected.cache_read_tokens)
										: "—"
								}
							/>
							<SummaryCard
								label="Cache writes"
								value={
									isNativeNumber(selected.cache_write_tokens)
										? formatNumber(selected.cache_write_tokens)
										: "—"
								}
							/>
							<SummaryCard
								label="Cache misses"
								value={
									cacheMissTokens(selected) === null
										? "—"
										: formatNumber(cacheMissTokens(selected) ?? 0)
								}
							/>
						</div>
					) : null}
					{importMessage ? (
						<p className="text-status-success text-xs" role="status">
							{importMessage}
						</p>
					) : null}
					{importError ? (
						<InlineErrorRow
							details={importError}
							message="Could not add this trace to Quality tests."
						/>
					) : null}

					{selected.session_id ? (
						<div className="border-border border-t pt-3">
							<div className="flex items-center gap-2 text-sm">
								<span className="font-semibold">Core run spans</span>
								{trace.length > 0 ? (
									<span className="text-muted-foreground/70 text-xs tabular-nums">
										{trace.length}
									</span>
								) : null}
							</div>
							{traceLoading ? (
								<p className="py-2 text-detail text-muted-foreground">
									Loading spans…
								</p>
							) : null}
							{traceError ? (
								<InlineErrorRow
									details={traceError}
									message="Spans could not be loaded."
								/>
							) : null}
							{!(traceLoading || traceError) && trace.length === 0 ? (
								<p className="py-2 text-detail text-muted-foreground">
									No Core spans were recorded for this session.
								</p>
							) : null}
							{trace.map((span) => (
								<TraceRow key={span.id} span={span} />
							))}
						</div>
					) : (
						<p className="text-detail text-muted-foreground">
							No Core session is linked, so no span timeline is available.
						</p>
					)}
				</SettingsCard>
				<SettingsCard className="flex flex-col gap-3">
					<div>
						<p className="font-semibold text-sm">Online scoring</p>
						<p className="mt-0.5 text-detail text-muted-foreground">
							Score a completed output without replaying its provider call.
						</p>
					</div>
					<Textarea
						aria-label="Completed output to score"
						className="min-h-20"
						onChange={(event) => setScoreResponse(event.target.value)}
						placeholder="Paste the completed model output here…"
						value={scoreResponse}
						variant="code-caption"
					/>
					<Input
						aria-label="Online scoring rubric"
						onChange={(event) => setScoreRubric(event.target.value)}
						placeholder="Optional rubric for an LLM judge"
						value={scoreRubric}
					/>
					<div className="flex flex-wrap items-center gap-2">
						<Button
							disabled={!scoreResponse.trim()}
							loading={scoring}
							onClick={() => scoreOnline().catch(() => undefined)}
							variant="outline"
						>
							Score output
						</Button>
						{scoreResult === null ? null : (
							<span className="text-sm tabular-nums">
								{tl("Online score {score}", {
									score: formatScore(scoreResult),
								})}
							</span>
						)}
					</div>
					{scoreError ? (
						<InlineErrorRow details={scoreError} message="Scoring failed." />
					) : null}
				</SettingsCard>
			</div>
		</SettingsSection>
	);
}
