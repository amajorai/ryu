// Credential-broker tools for an agent running through the broker.
//
// When an agent Ryu brokers (Claude Code, Codex, and other MCP hosts started
// with the broker's proxy variables) spawns ryu-mcp, this process inherits the
// agent's `rvb_` broker session. A request the broker refuses comes back as
// `403` with a `proposalHint`; these tools let the agent act on it: list the
// services it may reach, ask a person for a missing host or credential, and
// check whether the request was decided. A machine token (`RYU_VAULT_TOKEN`)
// works too. Credentials are named by reference (`secret:NAME`); no tool takes
// or returns a credential value.
//
// The tools are registered only when the process holds a session or token, so
// an ordinary MCP host never sees them, and only when Core can be verified
// before that credential is sent (see `brokerAgentTarget`).
//
// All logging MUST go to stderr: stdout is the JSON-RPC channel.

import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import type { AppJsonValue } from "@ryuhq/core-client/app-request-json";
import type { ApiTarget } from "@ryuhq/core-client/client";
import {
	type VaultAgentCredential,
	verifiedVaultAgentTarget,
} from "@ryuhq/core-client/core-identity-broker";
import {
	type VaultAgentTarget,
	vaultAgentBrokerDiscover,
	vaultAgentBrokerProposal,
	vaultAgentBrokerPropose,
} from "@ryuhq/core-client/vault";
import { brokerSessionFromEnv } from "@ryuhq/core-client/vault-broker-agent";
import * as z from "zod/v4";

type Env = Record<string, string | undefined>;

/** Where a broker-tool diagnostic goes: stderr, never the JSON-RPC stdout. */
type Warn = (message: string) => void;
const toStderr: Warn = (message) => {
	process.stderr.write(`ryu-mcp: ${message}\n`);
};

/**
 * The agent target for this process: a machine token, else its broker
 * session, sent only to a Core that can be verified
 * (`verifiedVaultAgentTarget`, the CLI's rule): https as is, a loopback
 * plain-HTTP Core after it proves the node token or the session, and never a
 * remote plain-HTTP address. Null (no tools) when there is no credential or
 * no way to verify Core with it.
 */
export function brokerAgentTarget(
	target: ApiTarget,
	env: Env,
	warn: Warn = toStderr
): VaultAgentTarget | null {
	const vaultToken = env.RYU_VAULT_TOKEN?.trim();
	const session = brokerSessionFromEnv(env);
	const credentials: VaultAgentCredential[] = [
		...(vaultToken ? [{ vaultToken }] : []),
		...(session ? [{ brokerSession: session }] : []),
	];
	let refusal: unknown = null;
	for (const credential of credentials) {
		try {
			return verifiedVaultAgentTarget(target, credential);
		} catch (error) {
			refusal ??= error;
		}
	}
	if (refusal) {
		const reason = refusal instanceof Error ? refusal.message : String(refusal);
		warn(`credential-broker tools are off: ${reason}`);
	}
	return null;
}

const referenceSchema = z
	.string()
	.regex(/^(secret:|op:\/\/|bws:\/\/)/, "a reference such as secret:NAME")
	.describe("Credential reference such as secret:LINEAR_TOKEN. Never a value.");

const authSchema = z.object({
	type: z.enum(["bearer", "api_key", "basic", "passthrough"]),
	token: referenceSchema.optional().describe("bearer: the token reference"),
	header: z.string().optional().describe("api_key: the header name"),
	value: referenceSchema.optional().describe("api_key: the key reference"),
	prefix: z.string().optional().describe("api_key: text before the value"),
	username: z.string().optional().describe("basic: username or reference"),
	password: referenceSchema.optional().describe("basic: password reference"),
});

const serviceSchema = z.object({
	name: z
		.string()
		.regex(/^[a-z0-9_-]{1,64}$/)
		.describe("Service name, 1-64 characters of [a-z0-9_-]."),
	host: z.string().describe("Host the agent needs, e.g. api.linear.app."),
	port: z.number().int().positive().optional(),
	pathPrefix: z.string().optional().describe("Path prefix, default /."),
	auth: authSchema.describe("How the broker adds the credential."),
	description: z.string().optional(),
});

export const proposeInputSchema = z.object({
	message: z
		.string()
		.min(1)
		.describe("Why the agent needs this, shown to the person who decides."),
	services: z.array(serviceSchema).max(10).optional(),
	credentials: z
		.array(
			z.object({
				ref: referenceSchema,
				description: z.string().optional(),
				obtainInstructions: z
					.string()
					.optional()
					.describe("How a person gets the value, e.g. which settings page."),
			})
		)
		.max(10)
		.optional(),
	environment: z
		.string()
		.optional()
		.describe("Environment (machine tokens only; a session has its own)."),
});

type ProposeInput = z.infer<typeof proposeInputSchema>;

function jsonRecord(value: object): Record<string, AppJsonValue> {
	const record: Record<string, AppJsonValue> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (entry === undefined) {
			continue;
		}
		record[key] =
			typeof entry === "object" && entry !== null && !Array.isArray(entry)
				? jsonRecord(entry)
				: entry;
	}
	return record;
}

/** The proposal body: services as JSON records, credentials as requests. */
export function proposalBody(input: ProposeInput) {
	return {
		message: input.message,
		services: (input.services ?? []).map(jsonRecord),
		credentials: (input.credentials ?? []).map((credential) => ({
			ref: credential.ref,
			description: credential.description ?? "",
			obtainInstructions: credential.obtainInstructions ?? "",
		})),
		...(input.environment ? { environment: input.environment } : {}),
	};
}

const reply = (value: unknown): CallToolResult => ({
	content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
});

const failure = (error: unknown): CallToolResult => ({
	content: [{ type: "text", text: String(error) }],
	isError: true,
});

const attempt = async (fn: () => Promise<unknown>): Promise<CallToolResult> => {
	try {
		return reply(await fn());
	} catch (error) {
		return failure(error);
	}
};

/** Register the broker tools when this process holds a session or token. */
export function registerBrokerTools(
	server: McpServer,
	target: ApiTarget,
	env: Env = process.env,
	warn: Warn = toStderr
): boolean {
	const agent = brokerAgentTarget(target, env, warn);
	if (!agent) {
		return false;
	}
	server.registerTool(
		"ryu_broker_discover",
		{
			title: "Ryu Broker Discover",
			description:
				"List the credential-broker services this agent may reach (host, auth kind, placeholders) and the environment's skills. Call it after a 403 from the broker proxy. Never returns credential values.",
			inputSchema: z.object({
				environment: z.string().optional(),
			}),
		},
		({ environment }) =>
			attempt(() => vaultAgentBrokerDiscover(agent, { environment }))
	);
	server.registerTool(
		"ryu_broker_propose",
		{
			title: "Ryu Broker Propose",
			description:
				"Ask a person to add a broker service for a host and/or provide credentials (by reference, e.g. secret:NAME). Use it when the broker proxy answers 403 for a host no service covers. The person is notified and approves or rejects; poll with ryu_broker_proposal.",
			inputSchema: proposeInputSchema,
		},
		(input) =>
			attempt(() => vaultAgentBrokerPropose(agent, proposalBody(input)))
	);
	server.registerTool(
		"ryu_broker_proposal",
		{
			title: "Ryu Broker Proposal",
			description:
				"Check a proposal this agent filed (or a credential-use approval it waits on): pending, approved, rejected, or expired.",
			inputSchema: z.object({ id: z.string().min(1) }),
		},
		({ id }) => attempt(() => vaultAgentBrokerProposal(agent, id))
	);
	return true;
}
