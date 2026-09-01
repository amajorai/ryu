import type { AuditEntry } from "@/src/lib/api/gateway.ts";
import type {
	OrganizationAuditEntry,
	OrganizationGatewayActivityEntry,
} from "@/src/lib/api/orgs.ts";

export type PassportActivityScope = "gateway" | "node" | "org";
export type PassportActivityOutcome = "failed" | "success";

export interface PassportActivityRow {
	action: string;
	actorId: string | null;
	actorLabel: string;
	actorType: "agent" | "gateway" | "system" | "user";
	agentAction: boolean;
	details: string;
	eventLabel: string;
	eventType: string;
	id: string;
	initiatedBy: string | null;
	initiatedById: string | null;
	outcome: PassportActivityOutcome;
	requestId: string | null;
	scope: PassportActivityScope;
	sessionId: string | null;
	target: string;
	timestamp: string;
}

const ACTION_LABELS: Record<string, string> = {
	"agent.auth.account-remove": "Agent account removed",
	"agent.auth.account-switch": "Agent account switched",
	"agent.auth.login": "Agent authenticated",
	"agent.auth.logout": "Agent signed out",
	"agent.capabilities.update": "Agent capabilities changed",
	"agent.create": "Agent created",
	"agent.delete": "Agent deleted",
	"agent.import": "Agent imported",
	"agent.migrate": "Agent migrated",
	"agent.prompt-version.create": "Prompt version saved",
	"agent.prompt-version.restore": "Prompt version restored",
	"agent.published.install": "Published agent installed",
	"agent.runtime.update": "Agent runtime updated",
	"agent.session.delete": "Agent session deleted",
	"agent.session.load": "Agent session loaded",
	"agent.setup.import": "Agent setup imported",
	"agent.thread.import": "Agent thread imported",
	"agent.update": "Agent configuration changed",
	"gateway.doctor.fix": "Gateway safety fix applied",
	"gateway.restart": "Gateway restarted",
	"policy.update": "Policy updated",
};

function actionKey(action: string): string {
	return action.split(":", 1)[0]?.trim() ?? action;
}

export function passportActionLabel(action: string): string {
	const key = actionKey(action);
	const known = ACTION_LABELS[key];
	if (known) {
		return known;
	}
	const words = key
		.replaceAll(/[._-]+/g, " ")
		.trim()
		.split(/\s+/)
		.filter(Boolean);
	if (words.length === 0) {
		return "Activity recorded";
	}
	return `${words[0].charAt(0).toUpperCase()}${words[0].slice(1)} ${words.slice(1).join(" ")}`;
}

function eventLabel(eventType: string): string {
	switch (eventType) {
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
			return "Activity";
	}
}

function compactId(value: string | null | undefined): string | null {
	if (!value) {
		return null;
	}
	return value.length > 20 ? `${value.slice(0, 10)}…${value.slice(-6)}` : value;
}

function detailsFromGateway(entry: {
	backend: string | null;
	command: string | null;
	costMicroUsd?: number | null;
	durationMs: number | null;
	error: string | null;
	eventType: string;
	feature: string | null;
	inputTokens: number;
	latencyMs: number;
	model: string;
	outputTokens: number;
	provider: string;
}): string {
	const parts: string[] = [];
	if (entry.eventType === "model_call") {
		parts.push(`${entry.provider} · ${entry.model}`);
		parts.push(`tokens ${entry.inputTokens + entry.outputTokens}`);
		parts.push(`latency ${entry.latencyMs}ms`);
	} else {
		if (entry.backend) {
			parts.push(entry.backend);
		}
		if (entry.command) {
			parts.push(entry.command);
		}
		if (entry.durationMs !== null) {
			parts.push(`duration ${entry.durationMs}ms`);
		}
	}
	if (entry.feature) {
		parts.push(`surface ${entry.feature}`);
	}
	if (entry.costMicroUsd !== undefined && entry.costMicroUsd !== null) {
		parts.push(`cost ${entry.costMicroUsd}µUSD`);
	}
	if (entry.error) {
		parts.push(`error: ${entry.error}`);
	}
	return parts.join(" · ") || "No additional metadata";
}

function detailsFromControl(entry: OrganizationAuditEntry): string {
	const parts: string[] = [];
	if (entry.feature) {
		parts.push(`surface ${entry.feature}`);
	}
	for (const [key, value] of Object.entries(entry.details)) {
		if (value === null || value === undefined) {
			continue;
		}
		if (typeof value === "string" || typeof value === "number") {
			parts.push(`${key}: ${value}`);
		} else if (typeof value === "boolean") {
			parts.push(`${key}: ${value ? "yes" : "no"}`);
		}
	}
	if (entry.error) {
		parts.push(`error: ${entry.error}`);
	}
	return parts.join(" · ") || "Change accepted by the control plane";
}

function userLabel(
	name: string | null | undefined,
	id: string | null | undefined
): string | null {
	return name ?? (id ? `User ${compactId(id)}` : null);
}

export function passportRowFromGateway(
	entry: AuditEntry,
	agentName: string
): PassportActivityRow {
	const type = entry.event_type ?? "model_call";
	const isControl = type === "control_change";
	const initiatedBy = userLabel(entry.user_name, entry.user_id);
	return {
		action: entry.command ?? type,
		actorId: isControl ? entry.user_id : entry.agent_id,
		actorLabel: isControl ? (initiatedBy ?? "Gateway admin") : agentName,
		actorType: isControl ? (entry.user_id ? "user" : "gateway") : "agent",
		agentAction: !isControl,
		details: detailsFromGateway({
			backend: entry.backend,
			command: entry.command,
			costMicroUsd: entry.cost_micro_usd,
			durationMs: entry.duration_ms,
			error: entry.error,
			eventType: type,
			feature: entry.feature,
			inputTokens: entry.input_tokens ?? 0,
			latencyMs: entry.latency_ms ?? 0,
			model: entry.model ?? "unknown",
			outputTokens: entry.output_tokens ?? 0,
			provider: entry.provider ?? "unknown",
		}),
		eventLabel: isControl
			? passportActionLabel(entry.command ?? type)
			: eventLabel(type),
		eventType: type,
		id: `node:${entry.id}`,
		initiatedBy: isControl ? null : initiatedBy,
		initiatedById: isControl ? null : entry.user_id,
		outcome: entry.error ? "failed" : "success",
		requestId: entry.request_id,
		scope: "node",
		sessionId: entry.session_id,
		target: entry.command ?? entry.model ?? entry.provider ?? "gateway",
		timestamp: entry.timestamp,
	};
}

export function passportRowFromOrganizationActivity(
	entry: OrganizationGatewayActivityEntry,
	agentName: string
): PassportActivityRow {
	const type = entry.eventType || "model_call";
	const initiatedBy = userLabel(entry.userName, entry.actorId);
	return {
		action: entry.command ?? type,
		actorId: entry.agentId,
		actorLabel: agentName,
		actorType: "agent",
		agentAction: true,
		details: detailsFromGateway(entry),
		eventLabel: eventLabel(type),
		eventType: type,
		id: `org-activity:${entry.id}`,
		initiatedBy,
		initiatedById: entry.actorId,
		outcome: entry.error ? "failed" : "success",
		requestId: entry.requestId,
		scope: "org",
		sessionId: entry.sessionId,
		target: entry.command ?? entry.model ?? entry.provider ?? "gateway",
		timestamp: entry.timestamp,
	};
}

export function passportRowFromOrganizationControl(
	entry: OrganizationAuditEntry
): PassportActivityRow {
	const actorLabel =
		entry.actor.name ??
		entry.actor.email ??
		(entry.actor.id ? `User ${compactId(entry.actor.id)}` : "System");
	const isAgentAction =
		entry.agentId !== null ||
		entry.target.startsWith("agent:") ||
		actionKey(entry.action).startsWith("agent.");
	return {
		action: entry.action,
		actorId: entry.actor.id,
		actorLabel,
		actorType: entry.actor.type,
		agentAction: false,
		details: detailsFromControl(entry),
		eventLabel: passportActionLabel(entry.action),
		eventType: entry.eventType || "control_change",
		id: `org-control:${entry.id}`,
		initiatedBy: isAgentAction ? actorLabel : null,
		initiatedById: isAgentAction ? entry.actor.id : null,
		outcome: entry.error ? "failed" : "success",
		requestId: entry.requestId,
		scope: entry.scope === "org" ? "org" : "gateway",
		sessionId: entry.sessionId,
		target: entry.targetId
			? `${entry.target} · ${entry.targetId}`
			: entry.target,
		timestamp: entry.timestamp,
	};
}

export function mergePassportActivity(
	rows: PassportActivityRow[],
	limit = 100
): PassportActivityRow[] {
	return [...rows]
		.sort((left, right) => {
			const difference =
				Date.parse(right.timestamp) - Date.parse(left.timestamp);
			return Number.isNaN(difference) ? 0 : difference;
		})
		.slice(0, limit);
}
