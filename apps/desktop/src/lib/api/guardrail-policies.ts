// apps/desktop/src/lib/api/guardrail-policies.ts
//
// Named guardrail policies and their assignments for one organization
// (managed guardrails spec 06.6), read and written with the Better Auth
// session bearer against the control plane, like orgs.ts:
//
//   GET    /api/control-plane/orgs/:orgId/guardrail-policies
//   POST   /api/control-plane/orgs/:orgId/guardrail-policies
//   PUT    /api/control-plane/orgs/:orgId/guardrail-policies/:policyId
//   POST   /api/control-plane/orgs/:orgId/guardrail-policies/:policyId/archive
//   PUT    /api/control-plane/orgs/:orgId/guardrail-assignments
//   DELETE /api/control-plane/orgs/:orgId/guardrail-assignments/:assignmentId
//   POST   /api/control-plane/orgs/:orgId/guardrail-policies/preview
//
// Every route needs `gateway.configure`. A write that loosens an assignment
// also needs a fresh `org.features` step-up; the server says so with a 403
// whose body names `STEP_UP_REQUIRED`, which this client surfaces as the
// error's `code` so the caller can prompt and retry only then.
//
// It also reads the choices the scope picker offers (teams, members and
// gateway keys) from the same control plane.

import type {
	PolicyPreviewView,
	PolicyScopeOptions,
	PolicyView,
} from "@ryu/blocks/desktop/guardrails/policy-model.ts";
import type { PolicyWorkspaceClient } from "@ryu/blocks/desktop/guardrails/policy-workspace.tsx";
import { STEP_UP_REQUIRED } from "@ryu/step-up";
import { z } from "zod";

/** A refusal with the server's stable `code` (for example `version_conflict`). */
export class GuardrailPolicyRequestError extends Error {
	readonly code: string | null;
	readonly status: number;

	constructor(status: number, code: string | null, message: string) {
		super(message);
		this.name = "GuardrailPolicyRequestError";
		this.code = code;
		this.status = status;
	}
}

export const GUARDRAIL_STEP_UP_REQUIRED = STEP_UP_REQUIRED;

/**
 * Where the control plane lives and how to read the session bearer. Passed in
 * by the caller (from `@/lib/auth-client.ts`) so this module stays free of the
 * auth client's start-up side effects.
 */
export interface ControlPlaneSession {
	baseUrl: string;
	token: () => string | null;
}

const orgBase = (session: ControlPlaneSession, orgId: string): string =>
	`${session.baseUrl.replace(/\/$/, "")}/api/control-plane/orgs/${encodeURIComponent(orgId)}`;

const refusalSchema = z.looseObject({
	code: z.string().optional(),
	error: z.unknown().optional(),
	message: z.string().optional(),
});

function refusalFrom(
	status: number,
	body: unknown
): GuardrailPolicyRequestError {
	const parsed = refusalSchema.safeParse(body);
	const data = parsed.success ? parsed.data : {};
	const code =
		data.code ?? (data.error === STEP_UP_REQUIRED ? STEP_UP_REQUIRED : null);
	const message =
		data.message ??
		(typeof data.error === "string" ? data.error : null) ??
		`Request failed (${status})`;
	return new GuardrailPolicyRequestError(status, code, message);
}

async function request<T>(
	session: ControlPlaneSession,
	url: string,
	decode: (value: unknown) => T,
	init?: { body?: unknown; method?: "DELETE" | "POST" | "PUT" }
): Promise<T> {
	const headers = new Headers();
	const token = session.token();
	if (token) {
		headers.set("Authorization", `Bearer ${token}`);
	}
	if (init?.body !== undefined) {
		headers.set("Content-Type", "application/json");
	}
	const response = await fetch(url, {
		body: init?.body === undefined ? undefined : JSON.stringify(init.body),
		headers,
		method: init?.method ?? "GET",
	});
	const body: unknown = await response.json().catch(() => null);
	if (!response.ok) {
		throw refusalFrom(response.status, body);
	}
	return decode(body);
}

const actionSchema = z.enum(["block", "warn_and_continue", "sanitize"]);
const scopeSchema = z.object({
	id: z.string(),
	kind: z.enum(["org", "team", "member", "key", "agent"]),
});
const assignmentSchema = z.looseObject({
	id: z.string(),
	policyId: z.string(),
	scope: scopeSchema,
});
const rulesSchema = z.looseObject({
	allowedRegions: z.array(z.string()).catch([]),
	approvedModels: z.array(z.string()).catch([]),
	approvedProviders: z.array(z.string()).catch([]),
	budgets: z
		.array(
			z.object({
				usdMicro: z.number(),
				window: z.enum(["daily", "weekly", "monthly", "lifetime"]),
			})
		)
		.catch([]),
	evaluators: z
		.array(z.object({ id: z.string(), inlineAction: actionSchema.optional() }))
		.catch([]),
	firewall: z
		.object({
			custom_patterns: z
				.array(
					z.object({
						kind: z.enum(["pii", "secret", "prompt_injection"]),
						name: z.string(),
						regex: z.string(),
					})
				)
				.optional(),
			enabled: z.literal(true).optional(),
			log_detections: z.literal(true).optional(),
			policy: actionSchema.optional(),
			redact_pii: z.literal(true).optional(),
			redact_secrets: z.literal(true).optional(),
			scan_inbound: z.literal(true).optional(),
			scan_outbound: z.literal(true).optional(),
		})
		.catch({}),
	permissions: z
		.array(
			z.object({
				action: z.enum(["tool.call", "mcp.use", "model.use"]),
				effect: z.enum(["allow", "ask", "deny"]),
				resource: z.string(),
			})
		)
		.catch([]),
	zeroDataRetention: z.boolean().nullable().catch(null),
});
const lockedSchema = z.array(
	z.enum([
		"approvedModels",
		"approvedProviders",
		"allowedRegions",
		"allowedTools",
		"deniedTools",
		"allowedMcpServers",
	])
);
const policySchema = z.looseObject({
	archivedAt: z.string().nullable(),
	assignments: z.array(assignmentSchema),
	description: z.string(),
	id: z.string(),
	locked: lockedSchema,
	name: z.string(),
	rules: rulesSchema,
	version: z.number().int(),
});

/** Decodes one wire policy into the workspace's view of it. */
export function decodePolicyView(value: unknown): PolicyView {
	return viewFrom(policySchema.parse(value));
}

function viewFrom(policy: z.output<typeof policySchema>): PolicyView {
	return {
		assignments: policy.assignments.map((assignment) => ({
			id: assignment.id,
			policyId: assignment.policyId,
			scope: assignment.scope,
		})),
		description: policy.description,
		id: policy.id,
		locked: policy.locked,
		name: policy.name,
		rules: {
			allowedRegions: policy.rules.allowedRegions,
			approvedModels: policy.rules.approvedModels,
			approvedProviders: policy.rules.approvedProviders,
			budgets: policy.rules.budgets,
			evaluators: policy.rules.evaluators,
			firewall: policy.rules.firewall,
			permissions: policy.rules.permissions,
			zeroDataRetention: policy.rules.zeroDataRetention,
		},
		version: policy.version,
	};
}

const sourceSchema = z.looseObject({
	layer: z.enum([
		"platform",
		"org",
		"team",
		"project",
		"member",
		"key",
		"agent",
	]),
	locked: z.boolean(),
	origin: z.string(),
	policyId: z.string().optional(),
	policyName: z.string().optional(),
	policyVersion: z.number().optional(),
	value: z.unknown(),
});
const eligibleSchema = z.object({
	allowed: z.array(z.string()),
	restricted: z.boolean(),
});
const previewSchema = z.looseObject({
	eligible: z.object({ models: eligibleSchema, providers: eligibleSchema }),
	fields: z.array(
		z.object({
			field: z.string(),
			sources: z.array(sourceSchema),
			value: z.unknown(),
		})
	),
	notes: z.array(z.string()),
	warnings: z.array(z.string()),
	zeroDataRetention: z.object({
		required: z.boolean(),
		sources: z.array(sourceSchema),
	}),
});

export function decodePolicyPreview(value: unknown): PolicyPreviewView {
	return previewSchema.parse(value);
}

/** The workspace client for one organization. */
export function desktopPolicyWorkspaceClient(
	session: ControlPlaneSession,
	orgId: string
): PolicyWorkspaceClient {
	const base = orgBase(session, orgId);
	const call = <T>(
		url: string,
		decode: (value: unknown) => T,
		init?: Parameters<typeof request>[3]
	) => request(session, url, decode, init);
	const policyUrl = (policyId: string) =>
		`${base}/guardrail-policies/${encodeURIComponent(policyId)}`;
	return {
		archive: (policyId) =>
			call(`${policyUrl(policyId)}/archive`, decodePolicyView, {
				method: "POST",
			}),
		assign: (input) =>
			call(`${base}/guardrail-assignments`, assignmentSchema.parse, {
				body: input,
				method: "PUT",
			}),
		create: (input) =>
			call(`${base}/guardrail-policies`, decodePolicyView, {
				body: input,
				method: "POST",
			}),
		list: async () => {
			const { policies } = await call(
				`${base}/guardrail-policies`,
				z.object({ policies: z.array(policySchema) }).parse
			);
			return policies
				.filter((policy) => policy.archivedAt === null)
				.map(viewFrom);
		},
		preview: (input) =>
			call(`${base}/guardrail-policies/preview`, decodePolicyPreview, {
				body: input,
				method: "POST",
			}),
		unassign: (assignmentId) =>
			call(
				`${base}/guardrail-assignments/${encodeURIComponent(assignmentId)}`,
				z.object({ deleted: z.boolean(), id: z.string() }).parse,
				{ method: "DELETE" }
			),
		update: (policyId, input) =>
			call(policyUrl(policyId), decodePolicyView, {
				body: input,
				method: "PUT",
			}),
	};
}

/**
 * Run a policy write, and retry it behind the `org.features` step-up only
 * when the server asks for one. Resolves `null` when the prompt is dismissed.
 */
export async function runGuardrailWrite<T>(
	guard: (scope: "org.features", action: () => Promise<T>) => Promise<T | null>,
	action: () => Promise<T>
): Promise<T | null> {
	try {
		return await action();
	} catch (error) {
		if (
			!(
				error instanceof GuardrailPolicyRequestError &&
				error.code === GUARDRAIL_STEP_UP_REQUIRED
			)
		) {
			throw error;
		}
		return await guard("org.features", action);
	}
}

const orgDetailSchema = z.looseObject({
	name: z.string().catch(""),
	teams: z.array(z.looseObject({ id: z.string(), name: z.string() })).catch([]),
});
const membersSchema = z.looseObject({
	members: z
		.array(
			z.looseObject({
				role: z.string().nullable().optional(),
				userId: z.string(),
			})
		)
		.catch([]),
});
const keysSchema = z.looseObject({
	keys: z
		.array(
			z.looseObject({
				id: z.string(),
				keyPrefix: z.string().catch(""),
				name: z.string(),
				revokedAt: z.string().nullable().catch(null),
			})
		)
		.nullish(),
});

/**
 * The scope picker's choices. Each source fails on its own, so a viewer who
 * cannot list keys still gets teams and members. Agents are typed by id.
 */
export async function loadPolicyScopeOptions(
	session: ControlPlaneSession,
	orgId: string
): Promise<PolicyScopeOptions> {
	const base = orgBase(session, orgId);
	const call = <T>(url: string, decode: (value: unknown) => T) =>
		request(session, url, decode);
	const [detail, members, keys] = await Promise.allSettled([
		call(base, orgDetailSchema.parse),
		call(`${base}/members`, membersSchema.parse),
		call(`${base}/gateway-keys`, keysSchema.parse),
	]);
	const org = detail.status === "fulfilled" ? detail.value : null;
	return {
		agent: [],
		key:
			keys.status === "fulfilled"
				? (keys.value.keys ?? [])
						.filter((key) => key.revokedAt === null)
						.map((key) => ({
							id: key.id,
							label: key.keyPrefix
								? `${key.name} (${key.keyPrefix})`
								: key.name,
						}))
				: [],
		member:
			members.status === "fulfilled"
				? members.value.members.map((member) => ({
						id: member.userId,
						label: member.role
							? `${member.userId} (${member.role})`
							: member.userId,
					}))
				: [],
		org: [{ id: orgId, label: org?.name || "This organization" }],
		team: (org?.teams ?? []).map((team) => ({ id: team.id, label: team.name })),
	};
}
