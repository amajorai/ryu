import { z } from "zod";
import {
	type FixtureJson,
	fixtureRecordSchema,
} from "./cli-fixture-contract.ts";
/** Safe request evidence and exact authority check for the merged CLI fixture. */
export interface CliFixtureRequestTrace {
	body: {
		kind: "review-agent-chat" | "other" | "empty";
		agent: "agent-reviewer" | "other" | null;
		conversationIdPresent: boolean;
		messageCount: number | null;
		messages: Array<{
			role: "user" | "assistant" | "other";
			text:
				| "advertise commands"
				| "/acp-review check staged changes"
				| "clear commands"
				| "hold stream"
				| "after stop"
				| "other";
		}>;
	};
	headers: {
		authorizationKind: "fixture-node" | "redacted" | null;
		userJwtPresent: boolean;
		buyerTokenPresent: boolean;
		contentType: "application/json" | "other" | null;
		surface: "cli" | "other" | null;
	};
	method: string;
	originKind: "expected" | "foreign";
	queryPresent: boolean;
	route: string;
}

const knownRoutes = new Set([
	"/api/health",
	"/api/auth/status",
	"/api/auth/user-jwt",
	"/api/auth/accounts",
	"/api/update/check",
	"/api/preferences/auto-updates",
	"/api/preferences/terminal-theme",
	"/api/preferences/theme",
	"/api/plugins",
	"/api/plugins/contributions",
	"/api/agents",
	"/api/teams",
	"/api/spaces",
	"/api/meetings",
	"/api/conversations",
	"/workflows",
	"/api/agents/agent-reviewer/acp-config",
	"/api/chat/stream",
	"/api/chat/cancel",
]);
const knownPromptSchema = z.enum([
	"advertise commands",
	"/acp-review check staged changes",
	"clear commands",
	"hold stream",
	"after stop",
]);
const fixtureMessagesSchema = z.array(z.json());
const fixtureTextSchema = z.string();
function projectBody(body: FixtureJson): CliFixtureRequestTrace["body"] {
	if (body === null) {
		return {
			kind: "empty",
			agent: null,
			conversationIdPresent: false,
			messageCount: null,
			messages: [],
		};
	}
	const parsed = fixtureRecordSchema.safeParse(body);
	if (!parsed.success) {
		return {
			kind: "other",
			agent: "other",
			conversationIdPresent: false,
			messageCount: null,
			messages: [],
		};
	}
	const record = parsed.data;
	const sourceMessages =
		fixtureMessagesSchema.safeParse(record.messages).data ?? null;
	return {
		kind:
			record.agent_id === "agent-reviewer" && sourceMessages
				? "review-agent-chat"
				: "other",
		agent: record.agent_id === "agent-reviewer" ? "agent-reviewer" : "other",
		conversationIdPresent:
			(fixtureTextSchema.safeParse(record.conversation_id).data?.length ?? 0) >
			0,
		messageCount: sourceMessages?.length ?? null,
		messages:
			sourceMessages?.map(
				(message): CliFixtureRequestTrace["body"]["messages"][number] => {
					const entry = fixtureRecordSchema.safeParse(message).data;
					if (!entry) {
						return { role: "other", text: "other" };
					}
					const content = fixtureMessagesSchema.safeParse(entry.content)
						.data?.[0];
					const part = fixtureRecordSchema.safeParse(content).data;
					const text = knownPromptSchema.safeParse(part?.text).data ?? "other";
					const role =
						entry.role === "user" || entry.role === "assistant"
							? entry.role
							: "other";
					return { role, text };
				}
			) ?? [],
	};
}

export function inspectCliFixtureRequest(
	request: Request,
	expectedOrigin: string,
	expectedToken: string,
	body: FixtureJson
): CliFixtureRequestInspection {
	const url = new URL(request.url);
	const authorization = request.headers.get("authorization");
	const userJwt = request.headers.get("x-ryu-user-jwt");
	const buyerToken = request.headers.get("x-ryu-buyer-token");
	const exactNodeAuthorization = authorization === `Bearer ${expectedToken}`;
	const contentType = request.headers.get("content-type");
	const surface = request.headers.get("x-ryu-surface");

	return {
		authorized:
			url.origin === expectedOrigin &&
			url.search.length === 0 &&
			exactNodeAuthorization &&
			userJwt === null &&
			buyerToken === null,
		trace: {
			method:
				request.method === "GET" || request.method === "POST"
					? request.method
					: "other",
			originKind: url.origin === expectedOrigin ? "expected" : "foreign",
			route: knownRoutes.has(url.pathname) ? url.pathname : "other",
			queryPresent: url.search.length > 0,
			headers: {
				authorizationKind: exactNodeAuthorization
					? "fixture-node"
					: authorization === null
						? null
						: "redacted",
				userJwtPresent: userJwt !== null,
				buyerTokenPresent: buyerToken !== null,
				contentType:
					contentType === null
						? null
						: contentType.split(";", 1)[0]?.trim().toLowerCase() ===
								"application/json"
							? "application/json"
							: "other",
				surface: surface === null ? null : surface === "cli" ? "cli" : "other",
			},
			body: projectBody(body),
		},
	};
}

export interface CliFixtureRequestInspection {
	authorized: boolean;
	trace: CliFixtureRequestTrace;
}
