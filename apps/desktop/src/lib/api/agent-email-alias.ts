// The agent's permanent email address, through Core's built-in `agent_inbox`
// tools. Desktop calls the same tools the agent calls in chat
// (`POST /api/mcp/tools/call`), so the button and the chat claim share one
// implementation, including Core's identity binding and approval policy.

import { z } from "zod";
import type { ApiTarget } from "./client.ts";
import { callMcpTool } from "./mcp.ts";

/** A refusal the tool returns as data (`{ok: false, status, code, message}`). */
export interface AgentEmailRefusal {
	code: string;
	message: string;
	ok: false;
	retryAfterSeconds?: number;
	status: number;
	suggestions: string[];
}

export interface AgentEmailAliasSummary {
	address: string;
	displayName: string;
	host: string;
	kind: string;
	localPart: string;
	status: "active" | "pending" | "revoked" | string;
}

export interface AgentEmailState {
	alias: AgentEmailAliasSummary | null;
	mailbox: { address: string } | null;
	ok: true;
}

export interface AgentEmailCheck {
	address: string;
	available: boolean;
	message?: string;
	ok: true;
	reason?: string;
	suggestions: string[];
}

export interface AgentEmailClaim {
	alias: AgentEmailAliasSummary;
	mailbox: { address: string } | null;
	message: string;
	ok: true;
	status: "active" | "pending_approval" | "existing";
}

const stringsSchema = z.array(z.string()).catch(() => []);

const refusalSchema = z.object({
	ok: z.literal(false),
	status: z.number().catch(500),
	code: z.string().catch("unavailable"),
	message: z.string().catch("The email service refused the request."),
	suggestions: stringsSchema.optional(),
	retry_after_s: z.number().optional().catch(undefined),
});

const aliasSchema = z.object({
	address: z.string().catch(""),
	display_name: z.string().catch(""),
	host: z.string().catch(""),
	kind: z.string().catch("alias"),
	local_part: z.string().catch(""),
	status: z.string().catch("active"),
});

const mailboxSchema = z.object({ address: z.string() }).nullable().catch(null);

const getSchema = z.object({
	ok: z.literal(true),
	has_alias: z.boolean().catch(false),
	alias: aliasSchema.optional(),
	mailbox: mailboxSchema.optional(),
});

const checkSchema = z.object({
	ok: z.literal(true),
	address: z.string().catch(""),
	available: z.boolean().catch(false),
	reason: z.string().optional().catch(undefined),
	message: z.string().optional().catch(undefined),
	suggestions: stringsSchema,
});

const claimSchema = z.object({
	ok: z.literal(true),
	status: z.enum(["active", "pending_approval", "existing"]).catch("active"),
	alias: aliasSchema,
	mailbox: mailboxSchema.optional(),
	message: z.string().catch(""),
});

const contentTextSchema = z.object({
	content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
});

/**
 * The tool's JSON result. Core returns it as the call output; an MCP-style
 * `{content: [{type: "text", text}]}` or a JSON string is unwrapped too.
 */
function toolResult(output: unknown): unknown {
	if (typeof output === "string") {
		try {
			return JSON.parse(output);
		} catch {
			return output;
		}
	}
	const content = contentTextSchema.safeParse(output);
	if (content.success) {
		const text = content.data.content.find((entry) => entry.type === "text");
		return text?.text ? toolResult(text.text) : output;
	}
	return output;
}

function summary(alias: z.output<typeof aliasSchema>): AgentEmailAliasSummary {
	return {
		address: alias.address,
		displayName: alias.display_name,
		host: alias.host,
		kind: alias.kind,
		localPart: alias.local_part,
		status: alias.status,
	};
}

function unavailable(message: string): AgentEmailRefusal {
	return {
		code: "unavailable",
		message,
		ok: false,
		status: 503,
		suggestions: [],
	};
}

async function callAgentInbox(
	target: ApiTarget,
	agentId: string,
	tool: "claim_email_alias" | "check_email_alias" | "get",
	args: Record<string, string>
): Promise<{ refusal: AgentEmailRefusal } | { value: unknown }> {
	let result: Awaited<ReturnType<typeof callMcpTool>>;
	try {
		result = await callMcpTool(target, {
			agentId,
			arguments: args,
			tool: `agent_inbox.${tool}`,
		});
	} catch (error) {
		return {
			refusal: unavailable(
				error instanceof Error ? error.message : "Ryu could not be reached."
			),
		};
	}
	if (!result.ok) {
		return {
			refusal: unavailable(result.error ?? "The email tool call failed."),
		};
	}
	const value = toolResult(result.output);
	const refusal = refusalSchema.safeParse(value);
	if (refusal.success) {
		return {
			refusal: {
				code: refusal.data.code,
				message: refusal.data.message,
				ok: false,
				status: refusal.data.status,
				suggestions: refusal.data.suggestions ?? [],
				...(refusal.data.retry_after_s === undefined
					? {}
					: { retryAfterSeconds: refusal.data.retry_after_s }),
			},
		};
	}
	return { value };
}

function malformed(): AgentEmailRefusal {
	return unavailable("The email tool returned an unexpected result.");
}

/** The agent's current address, if it has one (`agent_inbox.get`). */
export async function getAgentEmailAlias(
	target: ApiTarget,
	agentId: string
): Promise<AgentEmailState | AgentEmailRefusal> {
	const reply = await callAgentInbox(target, agentId, "get", {});
	if ("refusal" in reply) {
		return reply.refusal;
	}
	const parsed = getSchema.safeParse(reply.value);
	if (!parsed.success) {
		return malformed();
	}
	return {
		alias:
			parsed.data.has_alias && parsed.data.alias
				? summary(parsed.data.alias)
				: null,
		mailbox: parsed.data.mailbox ?? null,
		ok: true,
	};
}

/** Whether the agent could claim `localPart`, else its default name. */
export async function checkAgentEmailAlias(
	target: ApiTarget,
	agentId: string,
	localPart?: string
): Promise<AgentEmailCheck | AgentEmailRefusal> {
	const reply = await callAgentInbox(
		target,
		agentId,
		"check_email_alias",
		localPart ? { local_part: localPart } : {}
	);
	if ("refusal" in reply) {
		return reply.refusal;
	}
	const parsed = checkSchema.safeParse(reply.value);
	if (!parsed.success) {
		return malformed();
	}
	return {
		address: parsed.data.address,
		available: parsed.data.available,
		ok: true,
		suggestions: parsed.data.suggestions,
		...(parsed.data.reason ? { reason: parsed.data.reason } : {}),
		...(parsed.data.message ? { message: parsed.data.message } : {}),
	};
}

/** Claim the agent's permanent address (`agent_inbox.claim_email_alias`). */
export async function claimAgentEmailAlias(
	target: ApiTarget,
	agentId: string,
	input: { displayName?: string; localPart?: string } = {}
): Promise<AgentEmailClaim | AgentEmailRefusal> {
	const args: Record<string, string> = {};
	if (input.localPart) {
		args.local_part = input.localPart;
	}
	if (input.displayName) {
		args.display_name = input.displayName;
	}
	const reply = await callAgentInbox(
		target,
		agentId,
		"claim_email_alias",
		args
	);
	if ("refusal" in reply) {
		return reply.refusal;
	}
	const parsed = claimSchema.safeParse(reply.value);
	if (!parsed.success) {
		return malformed();
	}
	return {
		alias: summary(parsed.data.alias),
		mailbox: parsed.data.mailbox ?? null,
		message: parsed.data.message,
		ok: true,
		status: parsed.data.status,
	};
}

/** The local-part of a full address, for turning a suggestion into a name. */
export function localPartOf(address: string): string {
	const at = address.indexOf("@");
	return at > 0 ? address.slice(0, at) : address;
}
