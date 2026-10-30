import { Refresh01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip.tsx";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { CaptionInfo, StatusText } from "@/src/components/gateway/quiet.tsx";
import {
	SettingsCard,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import type { AuditEntry } from "@/src/lib/api/gateway.ts";
import { fetchGatewayAudit } from "@/src/lib/api/gateway.ts";
import { formatTime } from "@/src/lib/timezone.ts";
import { formatNumber } from "./shared.tsx";

// ── Audit table panel (M4 / #177) ────────────────────────────────────────────
//
// Read-only view of the gateway's audit log, proxied through Core.
// Columns: timestamp · provider · model · tokens (in/out) · latency ·
// eval_score · error. The api_key column is always "***" from the gateway and
// is intentionally not shown (use the keys card instead).

function formatLatency(ms: number | null): string {
	if (ms === null) {
		return "—";
	}
	if (ms < 1000) {
		return `${ms}ms`;
	}
	return `${(ms / 1000).toFixed(1)}s`;
}

function formatTokens(input: number | null, output: number | null): string {
	if (input === null && output === null) {
		return "—";
	}
	const i = input ?? 0;
	const o = output ?? 0;
	return `${formatNumber(i)} / ${formatNumber(o)}`;
}

function auditEventLabel(entry: AuditEntry): string {
	switch (entry.event_type) {
		case "model_call":
			return "Model call";
		case "exec_call":
			return "Tool execution";
		case "credential_read":
			return "Credential read";
		case "widget_follow_up":
			return "Widget follow-up";
		case "control_change":
			return "Control change";
		default:
			return entry.event_type ?? "Activity";
	}
}

function AuditTable({ entries }: { entries: AuditEntry[] }) {
	const tl = useLiteralMessages();
	return (
		<div className="overflow-x-auto">
			<table className="w-full text-sm">
				<thead>
					<tr className="border-b text-left text-muted-foreground text-xs">
						<th className="pr-3 pb-2 font-medium">Time</th>
						<th className="pr-3 pb-2 font-medium">Event / target</th>
						<th className="pr-3 pb-2 font-medium">Agent / caller</th>
						<th className="pr-3 pb-2 font-medium">Trace IDs</th>
						<th className="pr-3 pb-2 font-medium">Usage</th>
						<th className="pb-2 font-medium">Result</th>
					</tr>
				</thead>
				<tbody>
					{entries.map((entry) => {
						const ts = new Date(entry.timestamp);
						const timeStr = Number.isNaN(ts.getTime())
							? entry.timestamp
							: formatTime(ts);
						return (
							<tr className="border-b last:border-0" key={entry.id}>
								<Tooltip>
									<TooltipTrigger
										render={
											<td className="py-2 pr-3 text-xs tabular-nums">
												{timeStr}
											</td>
										}
									/>
									<TooltipContent>{entry.timestamp}</TooltipContent>
								</Tooltip>
								<td className="min-w-40 py-2 pr-3">
									<span className="text-sm">{auditEventLabel(entry)}</span>
									<div className="mt-1 max-w-48 truncate font-mono text-xs">
										{entry.command ?? entry.model ?? entry.provider ?? "—"}
									</div>
									<div className="text-muted-foreground text-xs">
										{entry.provider ?? entry.backend ?? "Gateway"}
									</div>
								</td>
								<td className="min-w-40 py-2 pr-3 text-xs">
									<div className="break-all font-mono">
										{tl("agent {id}", { id: entry.agent_id ?? "—" })}
									</div>
									<div className="mt-1 break-all text-muted-foreground">
										{entry.user_name ?? entry.user_id ?? "system / gateway"}
									</div>
								</td>
								<td className="min-w-44 py-2 pr-3 font-mono text-muted-foreground text-xs">
									<div className="break-all">
										{tl("request {request_id}", {
											request_id: entry.request_id,
										})}
									</div>
									{entry.session_id ? (
										<div className="mt-1 break-all">
											{tl("session {session_id}", {
												session_id: entry.session_id,
											})}
										</div>
									) : null}
								</td>
								<td className="min-w-32 py-2 pr-3 text-xs tabular-nums">
									<div>
										{tl("{tokens} tokens", {
											tokens: formatTokens(
												entry.input_tokens,
												entry.output_tokens
											),
										})}
									</div>
									<div className="mt-1 text-muted-foreground">
										{formatLatency(entry.latency_ms)}
										{entry.eval_score === null
											? ""
											: ` · ${tl("{percent}% score", { percent: Math.round(entry.eval_score * 100) })}`}
									</div>
								</td>
								<td className="max-w-48 py-2 text-xs">
									{entry.error ? (
										<StatusText tone="destructive">Failed</StatusText>
									) : (
										<span className="text-muted-foreground">Recorded</span>
									)}
									{entry.error ? (
										<div className="mt-1 max-w-48 break-words text-status-destructive">
											{entry.error}
										</div>
									) : null}
								</td>
							</tr>
						);
					})}
				</tbody>
			</table>
		</div>
	);
}

export function AuditPanel({ target }: { target: ApiTarget }) {
	const [entries, setEntries] = useState<AuditEntry[]>([]);
	const [reachable, setReachable] = useState<boolean | null>(null);
	const [loading, setLoading] = useState(false);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [errorsOnly, setErrorsOnly] = useState(false);
	// GatewayDialog rebuilds its ApiTarget object on parent renders (for example,
	// when the status poll or scoped-settings roster resolves). Keep this panel's
	// fetch identity tied to the actual node credentials so those unrelated
	// renders don't re-read the audit log or hide a transient read failure.
	const auditTarget = useMemo(
		() => ({
			token: target.token,
			url: target.url,
			userJwt: target.userJwt ?? null,
		}),
		[target.token, target.url, target.userJwt]
	);

	const load = useCallback(
		async (opts: { errorsOnly: boolean }) => {
			setLoading(true);
			setLoadError(null);
			try {
				const result = await fetchGatewayAudit(auditTarget, {
					errorsOnly: opts.errorsOnly,
					limit: 100,
				});
				setReachable(result.reachable);
				setEntries(result.entries);
			} catch (e) {
				setLoadError(
					e instanceof Error ? e.message : "Failed to load audit log"
				);
			} finally {
				setLoading(false);
			}
		},
		[auditTarget]
	);

	useEffect(() => {
		load({ errorsOnly });
	}, [load, errorsOnly]);

	const handleToggleErrors = (checked: boolean) => {
		setErrorsOnly(checked);
	};

	return (
		<SettingsSection
			caption={
				<CaptionInfo
					detail={
						"Every governed model, tool, credential, widget, and control event. Agent IDs, caller IDs, request IDs, and session IDs make each row followable; API keys, prompts, and tool payloads are always redacted. Newest first."
					}
				>
					{"Every governed model, tool and credential event, newest first."}
				</CaptionInfo>
			}
			headerAction={
				<div className="flex items-center gap-3">
					<div className="flex items-center gap-2">
						<Switch
							checked={errorsOnly}
							id="audit-errors-only"
							onCheckedChange={handleToggleErrors}
						/>
						<Label
							className="cursor-pointer"
							htmlFor="audit-errors-only"
							variant="choice"
						>
							Errors only
						</Label>
					</div>
					<Button
						disabled={loading}
						onClick={() => load({ errorsOnly })}
						size="sm"
						variant="ghost"
					>
						<HugeiconsIcon className="size-4" icon={Refresh01Icon} />
						Refresh
					</Button>
				</div>
			}
			title="Audit log"
		>
			<AuditBody
				entries={entries}
				loadError={loadError}
				loading={loading}
				onRefresh={() => load({ errorsOnly })}
				reachable={reachable}
			/>
		</SettingsSection>
	);
}

// ── Run-evals panel (M4 / #180) ──────────────────────────────────────────────
//
// v1 scorers: latency / token_efficiency / policy_pass / optional substring_match.
// LLM-judge scorers have since shipped, but not on this panel: it posts
// `dataset: []`, so every run replays the gateway's built-in 3-case set, and
// those cases carry no assertions — there is nothing here for a judge to score.
// Authoring cases with an `llm_judge` rubric, and picking the judge model, is
// Prompt Studio's surface; this panel still has no dataset import of its own.

function AuditBody({
	loading,
	loadError,
	onRefresh,
	reachable,
	entries,
}: {
	loading: boolean;
	loadError: string | null;
	onRefresh: () => void;
	reachable: boolean | null;
	entries: AuditEntry[];
}) {
	if (loading) {
		return (
			<SettingsCard>
				<SkeletonRows label="Loading…" spacing="comfortable" />
			</SettingsCard>
		);
	}
	if (loadError) {
		return (
			<AuditNotice
				action={
					<Button onClick={onRefresh} size="sm" variant="secondary">
						Try again
					</Button>
				}
				detail={loadError}
				title="Could not load audit log"
			/>
		);
	}
	if (reachable === false) {
		return (
			<AuditNotice
				action={
					<Button onClick={onRefresh} size="sm" variant="secondary">
						Try again
					</Button>
				}
				detail={
					<>
						The gateway is unreachable or audit logging is disabled. Start the
						gateway with <span className="font-mono">RYU_AUDIT_LOG=1</span> to
						enable audit logging.
					</>
				}
				title="Audit log unavailable"
			/>
		);
	}
	if (entries.length === 0) {
		return (
			<AuditNotice
				action={
					<Button onClick={onRefresh} size="sm" variant="secondary">
						Refresh audit log
					</Button>
				}
				detail="Run a model, tool, or control action through the gateway and refresh to see its trace."
				title="No audit entries yet"
			/>
		);
	}
	return (
		<SettingsCard>
			<AuditTable entries={entries} />
		</SettingsCard>
	);
}

/**
 * The audit panel's non-table states: one card holding a plain sentence, its
 * muted detail, and the recovery action on the right.
 */
function AuditNotice({
	action,
	detail,
	title,
}: {
	action: ReactNode;
	detail: ReactNode;
	title: string;
}) {
	return (
		<SettingsCard className="flex flex-wrap items-center justify-between gap-3">
			<div className="flex min-w-0 flex-1 flex-col gap-0.5">
				<p className="text-sm">{title}</p>
				<p className="break-words text-muted-foreground text-xs">{detail}</p>
			</div>
			{action}
		</SettingsCard>
	);
}
