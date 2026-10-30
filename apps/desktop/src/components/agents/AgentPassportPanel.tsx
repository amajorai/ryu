import {
	Activity01Icon,
	AlertCircleIcon,
	CheckmarkCircle02Icon,
	Refresh01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages, useRichLiteralMessages } from "@ryu/i18n/react";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import { useQuery } from "@tanstack/react-query";
import { format, formatDistanceToNow } from "date-fns";
import { type ReactNode, useMemo } from "react";
import { QuietEmpty } from "@/src/components/agents/shared/quiet-empty.tsx";
import { InlineErrorRow } from "@/src/components/chat/InlineErrorRow.tsx";
import {
	SettingsCard,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import {
	mergePassportActivity,
	type PassportActivityRow,
	passportRowFromGateway,
	passportRowFromOrganizationActivity,
	passportRowFromOrganizationControl,
} from "@/src/lib/agent-passport.ts";
import {
	type Agent,
	type AgentSummary,
	fetchAgent,
} from "@/src/lib/api/agents.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import { fetchGatewayAudit } from "@/src/lib/api/gateway.ts";
import {
	fetchOrganizationAgentActivity,
	fetchOrganizationAgentControls,
	type OrganizationAuditEntry,
	type OrganizationGatewayActivityEntry,
} from "@/src/lib/api/orgs.ts";

type AgentIdentity = Agent | AgentSummary;

interface AgentPassportPanelProps {
	agent: AgentIdentity;
	organizationId?: string | null;
	target: ApiTarget;
}

function hasDetail(agent: AgentIdentity): agent is Agent {
	return "tools" in agent;
}

function formatDate(value: string | null): string {
	if (!value) {
		return "Not recorded";
	}
	const parsed = new Date(value);
	return Number.isNaN(parsed.getTime())
		? value
		: format(parsed, "MMM d, yyyy · HH:mm:ss");
}

/** Only an exceptional lifecycle earns a badge; "active" is the normal state. */
function lifecycleBadgeVariant(
	status: AgentIdentity["lifecycleStatus"]
): "secondary" | "outline" | null {
	if (status === "active") {
		return null;
	}
	return status === "trial" ? "secondary" : "outline";
}

function humanizeSafetyProfile(value: AgentIdentity["safetyProfile"]): string {
	return value
		.split("_")
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(" ");
}

function PassportField({
	label,
	mono = false,
	value,
}: {
	label: string;
	mono?: boolean;
	value: string;
}) {
	return (
		<div className="min-w-0">
			<dt className="text-detail text-muted-foreground">{label}</dt>
			<dd
				className={`mt-0.5 break-words text-sm ${mono ? "font-mono" : ""}`}
				title={value}
			>
				{value}
			</dd>
		</div>
	);
}

function capabilityValue(
	detail: Agent | undefined,
	loading: boolean,
	value: string
): string {
	if (detail) {
		return value;
	}
	return loading ? "Loading…" : "Not available";
}

function activityTime(timestamp: string): string {
	const parsed = new Date(timestamp);
	if (Number.isNaN(parsed.getTime())) {
		return timestamp;
	}
	return `${format(parsed, "MMM d, yyyy · HH:mm:ss")} · ${formatDistanceToNow(parsed, { addSuffix: true })}`;
}

function emphasize(chunks: ReactNode): ReactNode {
	return <span className="font-medium text-foreground">{chunks}</span>;
}

function ActivityRow({ row }: { row: PassportActivityRow }) {
	const tl = useLiteralMessages();
	const tlRich = useRichLiteralMessages();
	const success = row.outcome === "success";
	const correlations = [
		row.requestId ? `request ${row.requestId}` : null,
		row.sessionId ? `session ${row.sessionId}` : null,
	].filter(Boolean);

	return (
		<div
			className="flex gap-3 border-border border-b py-3 last:border-b-0"
			data-testid="agent-passport-event"
		>
			<HugeiconsIcon
				aria-label={success ? "Completed" : "Failed"}
				className={`mt-0.5 size-4 shrink-0 ${success ? "text-status-success" : "text-status-destructive"}`}
				icon={success ? CheckmarkCircle02Icon : AlertCircleIcon}
				role="img"
			/>
			<div className="min-w-0 flex-1">
				<div className="flex flex-wrap items-center gap-2">
					<span className="font-medium text-sm">{row.eventLabel}</span>
					{success ? null : <Badge variant="destructive">Failed</Badge>}
					<span className="text-muted-foreground text-xs">{row.scope}</span>
				</div>
				<div className="mt-1 break-all font-mono text-muted-foreground text-xs">
					{row.action}
				</div>
				<div className="mt-1 break-words text-sm">{row.target}</div>
				<p className="mt-1 text-muted-foreground text-xs">
					{row.agentAction && row.initiatedBy
						? tlRich(
								"Performed by <b>{actorLabel}</b> on behalf of <b>{initiatedBy}</b>",
								{ actorLabel: row.actorLabel, initiatedBy: row.initiatedBy },
								{ b: emphasize }
							)
						: row.agentAction
							? tlRich(
									"Performed by <b>{actorLabel}</b>",
									{ actorLabel: row.actorLabel },
									{ b: emphasize }
								)
							: tlRich(
									"Changed by <b>{actorLabel}</b>",
									{ actorLabel: row.actorLabel },
									{ b: emphasize }
								)}
				</p>
				<div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 font-mono text-muted-foreground text-xs">
					{row.agentAction && row.actorId ? (
						<span className="break-all">
							{tl("agent {actorId}", { actorId: row.actorId })}
						</span>
					) : null}
					{!row.agentAction && row.actorId ? (
						<span className="break-all">
							{tl("actor {actorId}", { actorId: row.actorId })}
						</span>
					) : null}
					{row.initiatedById ? (
						<span className="break-all">
							{tl("user {initiatedById}", {
								initiatedById: row.initiatedById,
							})}
						</span>
					) : null}
				</div>
				<p className="mt-1 break-words text-muted-foreground text-xs">
					{row.details}
				</p>
				<div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-muted-foreground/70 text-xs">
					<span className="tabular-nums" title={row.timestamp}>
						{activityTime(row.timestamp)}
					</span>
					{correlations.map((value) => (
						<span className="font-mono" key={value}>
							{value}
						</span>
					))}
				</div>
			</div>
		</div>
	);
}

async function loadPassportActivity(
	agent: AgentIdentity,
	target: ApiTarget,
	organizationId: string | null
): Promise<PassportActivityRow[]> {
	if (!organizationId) {
		const result = await fetchGatewayAudit(target, {
			agentId: agent.id,
			limit: 200,
		});
		return result.entries.map((entry) =>
			passportRowFromGateway(entry, agent.name)
		);
	}

	const [activityResult, controlsResult] = await Promise.allSettled([
		fetchOrganizationAgentActivity(organizationId, agent.id),
		fetchOrganizationAgentControls(organizationId, agent.id),
	]);
	const rows: PassportActivityRow[] = [];
	if (activityResult.status === "fulfilled") {
		rows.push(
			...activityResult.value.entries.map(
				(entry: OrganizationGatewayActivityEntry) =>
					passportRowFromOrganizationActivity(entry, agent.name)
			)
		);
	}
	if (controlsResult.status === "fulfilled") {
		rows.push(
			...controlsResult.value.entries.map((entry: OrganizationAuditEntry) =>
				passportRowFromOrganizationControl(entry)
			)
		);
	}
	if (rows.length > 0) {
		return mergePassportActivity(rows);
	}
	// A local node may be bound to a personal organization that does not report
	// Gateway rows upstream yet. Prefer the organization projection when it has
	// data, but keep the passport useful locally while the reporter catches up.
	try {
		const localResult = await fetchGatewayAudit(target, {
			agentId: agent.id,
			limit: 200,
		});
		if (localResult.entries.length > 0) {
			return mergePassportActivity(
				localResult.entries.map((entry) =>
					passportRowFromGateway(entry, agent.name)
				)
			);
		}
	} catch {
		// Organization audit is the authoritative source for an org-bound viewer.
		// A local owner-only fallback is best effort and may be unavailable.
	}
	if (
		activityResult.status === "fulfilled" ||
		controlsResult.status === "fulfilled"
	) {
		return [];
	}

	const failure = [activityResult, controlsResult]
		.filter(
			(result): result is PromiseRejectedResult => result.status === "rejected"
		)
		.map((result) =>
			result.reason instanceof Error ? result.reason.message : "request failed"
		)
		.filter(Boolean);
	throw new Error(failure[0] ?? "Organization activity is unavailable.");
}

export function AgentPassportPanel({
	agent,
	organizationId = null,
	target,
}: AgentPassportPanelProps) {
	const detailQuery = useQuery({
		enabled: !hasDetail(agent),
		queryFn: () => fetchAgent(target, agent.id),
		queryKey: ["agent-passport-detail", target.url, agent.id],
		retry: false,
	});
	const auditQuery = useQuery({
		queryFn: () => loadPassportActivity(agent, target, organizationId ?? null),
		queryKey: [
			"agent-passport-audit",
			organizationId ?? "node",
			target.url,
			agent.id,
		],
		retry: false,
		staleTime: 15_000,
	});

	const detail = hasDetail(agent) ? agent : detailQuery.data;
	const activity = useMemo(
		() => mergePassportActivity(auditQuery.data ?? []),
		[auditQuery.data]
	);
	const model = detail?.chatModel?.modelId ?? agent.model ?? "Not pinned";
	const engine = detail?.chatModel?.engine ?? agent.engine ?? "Not reported";
	const lifecycleBadge = lifecycleBadgeVariant(agent.lifecycleStatus);

	return (
		<div className="flex flex-col gap-6" data-testid="agent-passport">
			<SettingsSection
				caption="Read-only identity and event ledger. Prompts and credentials are never shown."
				title="Agent passport"
			>
				<SettingsCard>
					<div className="min-w-0">
						<div className="flex flex-wrap items-center gap-2">
							<h3 className="font-medium text-sm">{agent.name}</h3>
							{lifecycleBadge ? (
								<Badge variant={lifecycleBadge}>{agent.lifecycleStatus}</Badge>
							) : null}
							{agent.locked ? <Badge variant="secondary">Locked</Badge> : null}
						</div>
						{agent.description ? (
							<p className="mt-0.5 text-detail text-muted-foreground">
								{agent.description}
							</p>
						) : null}
					</div>

					<dl className="mt-4 grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
						<PassportField label="Agent ID" mono value={agent.id} />
						<PassportField
							label="Safety profile"
							value={humanizeSafetyProfile(agent.safetyProfile)}
						/>
						<PassportField label="Runtime" value={engine} />
						<PassportField label="Model" value={model} />
						<PassportField
							label="Version"
							value={agent.version ?? "Unversioned"}
						/>
						<PassportField
							label="Source"
							value={agent.builtIn ? "Ryu built-in" : "Organization agent"}
						/>
						<PassportField
							label="Created"
							value={formatDate(agent.createdAt)}
						/>
						<PassportField
							label="Last configuration"
							value={formatDate(detail?.updatedAt ?? null)}
						/>
					</dl>

					<dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-3 border-border border-t pt-3 sm:grid-cols-2 lg:grid-cols-4">
						<PassportField
							label="Tools"
							value={capabilityValue(
								detail,
								detailQuery.isLoading,
								detail?.tools.length
									? `${detail.tools.length} allowlisted`
									: "All enabled"
							)}
						/>
						<PassportField
							label="Skills"
							value={capabilityValue(
								detail,
								detailQuery.isLoading,
								detail?.skills.length
									? `${detail.skills.length} allowlisted`
									: "All enabled"
							)}
						/>
						<PassportField
							label="Identity bindings"
							value={capabilityValue(
								detail,
								detailQuery.isLoading,
								`${detail?.identityProfileIds.length ?? 0} profile${detail?.identityProfileIds.length === 1 ? "" : "s"}`
							)}
						/>
						<PassportField
							label="Memory"
							value={capabilityValue(
								detail,
								detailQuery.isLoading,
								detail?.memory.write_enabled ? "Read + write" : "Read only"
							)}
						/>
					</dl>
				</SettingsCard>
			</SettingsSection>

			<SettingsSection
				caption="Governed actions and control changes, with request and session IDs."
				headerAction={
					<Button
						disabled={auditQuery.isFetching}
						onClick={() => void auditQuery.refetch()}
						size="icon-sm"
						title="Refresh"
						variant="ghost-muted"
					>
						<HugeiconsIcon className="size-4" icon={Refresh01Icon} />
						<span className="sr-only">Refresh</span>
					</Button>
				}
				title="Trace ledger"
			>
				<SettingsCard className="p-0">
					{auditQuery.isLoading ? (
						<SkeletonRows inset="detail" label="Loading agent activity…" />
					) : auditQuery.isError ? (
						<InlineErrorRow
							details={
								auditQuery.error instanceof Error
									? auditQuery.error.message
									: null
							}
							message="Activity could not be loaded."
							onRetry={() => void auditQuery.refetch()}
						/>
					) : activity.length === 0 ? (
						<QuietEmpty
							description="Model, tool and control events will appear here."
							icon={Activity01Icon}
							title="No trace events yet"
						/>
					) : (
						<div data-testid="agent-passport-activity">
							{activity.map((row) => (
								<ActivityRow key={row.id} row={row} />
							))}
						</div>
					)}
				</SettingsCard>
			</SettingsSection>
		</div>
	);
}
