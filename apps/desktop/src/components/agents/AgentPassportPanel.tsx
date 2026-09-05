import {
	Activity01Icon,
	AlertCircleIcon,
	CheckmarkCircle02Icon,
	Refresh01Icon,
	Shield01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { Spinner } from "@ryu/ui/components/spinner.tsx";
import { useQuery } from "@tanstack/react-query";
import { format, formatDistanceToNow } from "date-fns";
import { useMemo } from "react";
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

function statusVariant(
	status: AgentIdentity["lifecycleStatus"]
): "default" | "secondary" | "outline" {
	if (status === "active") {
		return "default";
	}
	if (status === "trial") {
		return "secondary";
	}
	return "outline";
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
		<div className="min-w-0 rounded-lg border bg-muted/20 p-3">
			<dt className="font-medium text-muted-foreground text-xs">{label}</dt>
			<dd
				className={`mt-1 break-words text-sm ${mono ? "font-mono text-xs" : ""}`}
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

function ActivityRow({ row }: { row: PassportActivityRow }) {
	const success = row.outcome === "success";
	const correlations = [
		row.requestId ? `request ${row.requestId}` : null,
		row.sessionId ? `session ${row.sessionId}` : null,
	].filter(Boolean);

	return (
		<div
			className="flex gap-3 border-b py-4 last:border-b-0"
			data-testid="agent-passport-event"
		>
			<div
				className={`mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full ${success ? "bg-success/10 text-success" : "bg-destructive/10 text-destructive"}`}
			>
				<HugeiconsIcon
					className="size-4"
					icon={success ? CheckmarkCircle02Icon : AlertCircleIcon}
				/>
			</div>
			<div className="min-w-0 flex-1">
				<div className="flex flex-wrap items-center gap-2">
					<span className="font-medium text-sm">{row.eventLabel}</span>
					<Badge variant={success ? "secondary" : "destructive"}>
						{success ? "Completed" : "Failed"}
					</Badge>
					<Badge variant="outline">{row.scope}</Badge>
				</div>
				<div className="mt-1 break-all font-mono text-[10px] text-muted-foreground">
					{row.action}
				</div>
				<div className="mt-1 break-words font-medium text-sm">{row.target}</div>
				<p className="mt-1 text-muted-foreground text-xs">
					{row.agentAction ? (
						<>
							Performed by{" "}
							<span className="font-medium text-foreground">
								{row.actorLabel}
							</span>
							{row.initiatedBy ? (
								<>
									{" "}
									on behalf of{" "}
									<span className="font-medium text-foreground">
										{row.initiatedBy}
									</span>
								</>
							) : null}
						</>
					) : (
						<>
							Changed by{" "}
							<span className="font-medium text-foreground">
								{row.actorLabel}
							</span>
						</>
					)}
				</p>
				<div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[10px] text-muted-foreground">
					{row.agentAction && row.actorId ? (
						<span className="break-all">agent {row.actorId}</span>
					) : null}
					{!row.agentAction && row.actorId ? (
						<span className="break-all">actor {row.actorId}</span>
					) : null}
					{row.initiatedById ? (
						<span className="break-all">user {row.initiatedById}</span>
					) : null}
				</div>
				<p className="mt-1 break-words text-muted-foreground text-xs">
					{row.details}
				</p>
				<div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[10px] text-muted-foreground">
					<span title={row.timestamp}>{activityTime(row.timestamp)}</span>
					{correlations.map((value) => (
						<span key={value}>{value}</span>
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

	return (
		<div className="flex flex-col gap-6" data-testid="agent-passport">
			<SettingsSection
				caption="A read-only identity card and event ledger for this agent. Every action names the agent, the human or system that initiated it, and the request or session correlation when available. Prompt and credential payloads are never shown."
				headerAction={
					<Badge className="gap-1" variant="outline">
						<HugeiconsIcon className="size-3" icon={Shield01Icon} />
						Traceable identity
					</Badge>
				}
				title="Agent passport"
			>
				<SettingsCard>
					<div className="flex items-start gap-3">
						<div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
							<HugeiconsIcon className="size-5" icon={Shield01Icon} />
						</div>
						<div className="min-w-0 flex-1">
							<div className="flex flex-wrap items-center gap-2">
								<h3 className="font-medium text-base">{agent.name}</h3>
								<Badge variant={statusVariant(agent.lifecycleStatus)}>
									{agent.lifecycleStatus}
								</Badge>
								{agent.locked ? (
									<Badge variant="secondary">Locked</Badge>
								) : null}
							</div>
							<p className="mt-1 text-muted-foreground text-xs">
								{agent.description ?? "No description recorded."}
							</p>
						</div>
					</div>

					<dl className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
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

					<div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
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
					</div>
				</SettingsCard>
			</SettingsSection>

			<SettingsSection
				caption="The latest governed actions and human control changes for this agent. Request and session IDs are shown so an operator can follow a row into its run transcript or Gateway record."
				headerAction={
					<Button
						disabled={auditQuery.isFetching}
						onClick={() => void auditQuery.refetch()}
						size="sm"
						variant="ghost"
					>
						<HugeiconsIcon className="size-4" icon={Refresh01Icon} />
						Refresh
					</Button>
				}
				title="Trace ledger"
			>
				<SettingsCard className="p-0">
					{auditQuery.isLoading ? (
						<div className="flex items-center gap-2 p-5 text-muted-foreground text-sm">
							<Spinner className="size-4" /> Loading agent activity…
						</div>
					) : auditQuery.isError ? (
						<div className="flex flex-col items-center gap-3 p-8 text-center">
							<HugeiconsIcon
								className="size-5 text-muted-foreground"
								icon={AlertCircleIcon}
							/>
							<p className="font-medium text-sm">
								Activity could not be loaded
							</p>
							<p className="max-w-md text-muted-foreground text-xs">
								{auditQuery.error instanceof Error
									? auditQuery.error.message
									: "The organization or node audit source is unavailable."}
							</p>
							<Button
								onClick={() => void auditQuery.refetch()}
								size="sm"
								variant="outline"
							>
								Try again
							</Button>
						</div>
					) : activity.length === 0 ? (
						<div className="flex flex-col items-center gap-2 p-8 text-center">
							<HugeiconsIcon
								className="size-5 text-muted-foreground"
								icon={Activity01Icon}
							/>
							<p className="font-medium text-sm">No trace events yet</p>
							<p className="max-w-md text-muted-foreground text-xs">
								When this agent runs a model or tool, or someone changes its
								controls, that event will appear here with its actor and
								correlation IDs.
							</p>
						</div>
					) : (
						<div className="px-4" data-testid="agent-passport-activity">
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
