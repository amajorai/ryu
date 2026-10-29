// packages/services/src/managed-agents/namespace.ts
//
// `ryu.managedAgents`: a 1:1 wrap of `@ryuhq/client`'s Managed Agents client
// plus `iterate()` on agents, environments and sessions, `sessions.follow()`,
// `sessions.run()`, and `sessions.approveTool()` / `sessions.denyTool()` for
// interactive tool approvals. The client's `sessions.respondToApproval()` is
// replaced by the same helper, so every answer path derives the same
// Idempotency-Key (the raw client sends a random one per call).
//
// It runs in `passthrough` error mode: the shim hands non-2xx responses back
// untouched so the client raises ManagedAgentsError, which its stream loop
// treats as fatal (no reconnect), and the facade converts it to RyuError at
// the boundary. Throwing RyuError from inside fetch instead would make
// `sessions.stream` reconnect on a 401 forever. For the same reason a signal
// bound with `.with({ signal })` is forwarded into `sessions.stream`: the
// stream loop only stops on its own signal and treats any other fetch failure
// (the shim's RyuAbortError included) as a dropped connection.
//
// The two "preview is off" codes (`503 managed_agents_disabled`,
// `403 feature_disabled`) get a hint and a docs link to the preview page from
// `decorateManagedAgentsError`, which the facade applies to every error after
// adding the call's context (method, URL, Idempotency-Key, attempts).

import {
	createManagedAgentsClient,
	type ManagedAgent,
	type ManagedAgentEnvironment,
	type ManagedAgentEvent,
	type ManagedAgentSession,
	type ManagedAgentsAPI,
	type ManagedAgentsList,
	type RyuFetch,
} from "@ryuhq/client";
import type { ResolvedServiceConfig } from "../config.ts";
import { copyRyuError, type RyuError } from "../errors.ts";
import type { Paginated } from "../pagination.ts";
import { type CallOptions, linkSignals } from "../transport/fetch-shim.ts";
import { pathSegment } from "../transport/request.ts";
import type { NamespaceDefinition } from "../wrap.ts";
import {
	MANAGED_AGENTS_PREVIEW_DOCS,
	managedAgentsPreviewHint,
} from "./codes.ts";
import {
	answerToolApproval,
	followSession,
	type ManagedAgentFollowOptions,
	type ManagedAgentSessionRun,
	type ManagedAgentSessionRunInput,
	type ManagedAgentSessionRunOptions,
	type ManagedAgentToolAnswerOptions,
	type ManagedAgentToolApproval,
	runSession,
} from "./helpers.ts";
import {
	iterateAgents,
	iterateEnvironments,
	iterateSessions,
	type ManagedAgentEnvironmentIterateQuery,
	type ManagedAgentIterateQuery,
	type ManagedAgentSessionIterateQuery,
} from "./iterate.ts";
import { MANAGED_AGENTS_ROUTES } from "./routes.ts";

type AgentsAPI = ManagedAgentsAPI["agents"];
type CredentialsAPI = ManagedAgentsAPI["credentials"];
type EnvironmentsAPI = ManagedAgentsAPI["environments"];
type SessionsAPI = ManagedAgentsAPI["sessions"];

/** `ryu.managedAgents.agents`: the client's agents API plus `iterate()`. */
export interface ManagedAgentsAgentsNamespace extends AgentsAPI {
	/** Every agent across pages (`cursor` → `nextCursor`). Throws RyuError, also in object mode. */
	iterate(
		query?: ManagedAgentIterateQuery
	): Paginated<ManagedAgent, ManagedAgentsList<ManagedAgent>>;
}

/** `ryu.managedAgents.environments`: the client's environments API plus `iterate()`. */
export interface ManagedAgentsEnvironmentsNamespace extends EnvironmentsAPI {
	/** Every environment across pages. Throws RyuError, also in object mode. */
	iterate(
		query?: ManagedAgentEnvironmentIterateQuery
	): Paginated<
		ManagedAgentEnvironment,
		ManagedAgentsList<ManagedAgentEnvironment>
	>;
}

/**
 * `ryu.managedAgents.sessions`: the client's sessions API plus `iterate()`,
 * `follow()`, `run()`, `approveTool()` and `denyTool()`.
 */
export interface ManagedAgentsSessionsNamespace extends SessionsAPI {
	/**
	 * Allows the tool call of an open `agent.tool_approval_request`: appends a
	 * `user.tool_approval` with decision `allow`. The default Idempotency-Key
	 * is derived from the decision, `toolUseId` and `message`, so a retry of
	 * the same answer replays the first one; a retry must reuse the same
	 * message. Errors: `409 tool_result_already_submitted` when the request
	 * already has an answer (another client's, or Ryu's timeout denial at
	 * `expiresAt`), `409 unknown_tool_use` when the id is not pending and was
	 * never answered (a wrong id, or a request an interrupt abandoned).
	 */
	approveTool(
		sessionId: string,
		toolUseId: string,
		options?: ManagedAgentToolAnswerOptions
	): Promise<ManagedAgentToolApproval>;
	/**
	 * Denies the tool call of an open `agent.tool_approval_request`; the model
	 * sees `message` (or Ryu's default denial text). Same idempotency and
	 * errors as {@link ManagedAgentsSessionsNamespace.approveTool}.
	 */
	denyTool(
		sessionId: string,
		toolUseId: string,
		options?: ManagedAgentToolAnswerOptions
	): Promise<ManagedAgentToolApproval>;
	/**
	 * Streams the session's log until the current turn ends (the `idle` status
	 * that answers the last user event), or with `until: "terminal"` until the
	 * session ends. Reconnects like `stream()`. With `onToolApproval` it
	 * answers approval requests (also ones at or before `after`) and keeps
	 * going; without it nothing is answered and the follow stops at the
	 * `requires_action` idle, in either `until` mode.
	 */
	follow(
		sessionId: string,
		options?: ManagedAgentFollowOptions
	): AsyncGenerator<ManagedAgentEvent>;
	/** Every session visible to the caller across pages. Throws RyuError, also in object mode. */
	iterate(
		query?: ManagedAgentSessionIterateQuery
	): Paginated<ManagedAgentSession, ManagedAgentsList<ManagedAgentSession>>;
	/**
	 * Creates a session (with `message` as its first `user.message`), follows
	 * it until the turn ends (or with `until: "terminal"` until the session
	 * ends), then re-reads it. Approval requests go to `onToolApproval`; any
	 * still open when the run stops are in `pendingApprovals`.
	 */
	/**
	 * `approveTool()` or `denyTool()` by `decision`, with the same derived
	 * Idempotency-Key (the raw client method sends a random key per call).
	 * Prefer `approveTool()` / `denyTool()`.
	 */
	respondToApproval(
		sessionId: string,
		toolUseId: string,
		decision: "allow" | "deny",
		options?: ManagedAgentToolAnswerOptions
	): Promise<ManagedAgentToolApproval>;
	run(
		input: ManagedAgentSessionRunInput,
		options?: ManagedAgentSessionRunOptions
	): Promise<ManagedAgentSessionRun>;
}

/** `ryu.managedAgents`: `agents`, `environments`, `credentials` (read-only) and `sessions`. */
export interface ManagedAgentsNamespace {
	readonly agents: ManagedAgentsAgentsNamespace;
	/** Read-only: credential writes need a signed-in console session with a fresh step-up. */
	readonly credentials: CredentialsAPI;
	readonly environments: ManagedAgentsEnvironmentsNamespace;
	readonly sessions: ManagedAgentsSessionsNamespace;
}

/** Extra signals (a `run()` signal) that every request of the call also stops on. */
interface SignalLinker {
	fetch: RyuFetch;
	/** Links `signal` into every later request until the returned undo runs. */
	linkSignal(signal: AbortSignal): () => void;
}

function linkRequestSignals(fetch: RyuFetch): SignalLinker {
	const extraSignals = new Set<AbortSignal>();
	return {
		fetch: async (input, init) => {
			if (extraSignals.size === 0) {
				return await fetch(input, init);
			}
			const own = init?.signal ?? null;
			const linked = linkSignals(
				own === null ? [...extraSignals] : [own, ...extraSignals]
			);
			try {
				return await fetch(input, { ...init, signal: linked.signal ?? null });
			} finally {
				linked.dispose();
			}
		},
		linkSignal: (signal) => {
			extraSignals.add(signal);
			return () => extraSignals.delete(signal);
		},
	};
}

function defineMethod(target: object, name: string, value: unknown): void {
	Object.defineProperty(target, name, {
		configurable: true,
		value,
		writable: true,
	});
}

/**
 * Checks the session id before `sessions.stream` (and `follow`, which uses
 * it) opens the stream. The shim refuses a `.`, `..` or empty path id with
 * RyuInvalidRequestError, but the stream loop would read that thrown error as
 * a dropped connection and reconnect, so the id is refused here first.
 */
function guardStreamSessionId(client: ManagedAgentsAPI): void {
	const { sessions } = client;
	const stream = sessions.stream.bind(sessions);
	defineMethod(
		sessions,
		"stream",
		async function* checkedStream(
			sessionId: string,
			streamOptions?: Parameters<typeof stream>[1]
		): AsyncGenerator<ManagedAgentEvent> {
			pathSegment("managedAgents", sessionId, "the session id");
			yield* stream(sessionId, streamOptions);
		}
	);
}

/**
 * Makes `client.sessions.stream` also stop when `signal` aborts, by linking it
 * with any signal the caller passes to `stream` itself. The link is disposed
 * when the stream ends.
 */
function bindStreamSignal(client: ManagedAgentsAPI, signal: AbortSignal): void {
	const { sessions } = client;
	const stream = sessions.stream.bind(sessions);
	defineMethod(
		sessions,
		"stream",
		async function* linkedStream(
			sessionId: string,
			streamOptions: Parameters<typeof stream>[1] = {}
		): AsyncGenerator<ManagedAgentEvent> {
			const linked = linkSignals(
				streamOptions.signal ? [streamOptions.signal, signal] : [signal]
			);
			try {
				yield* stream(sessionId, { ...streamOptions, signal: linked.signal });
			} finally {
				linked.dispose();
			}
		}
	);
}

/**
 * Adds the preview hint and docs link to a Managed Agents "preview is off"
 * error (`503 managed_agents_disabled`, `403 feature_disabled`); returns any
 * other error unchanged.
 */
export function decorateManagedAgentsError(error: RyuError): RyuError {
	if (error.envelope !== "managed-agents" || error.hint !== null) {
		return error;
	}
	const hint = managedAgentsPreviewHint(error.code);
	return hint === null
		? error
		: copyRyuError(error, { docs: MANAGED_AGENTS_PREVIEW_DOCS, hint });
}

/** Builds the Managed Agents client for one call. Does no I/O. */
export function createManagedAgentsNamespace(
	config: ResolvedServiceConfig,
	fetch: RyuFetch,
	options: CallOptions = {}
): ManagedAgentsNamespace {
	const linker = linkRequestSignals(fetch);
	const client = createManagedAgentsClient({
		apiKey: config.apiKey ?? "",
		baseUrl: config.baseUrl,
		fetch: linker.fetch,
		organizationId: config.organizationId ?? undefined,
	});
	guardStreamSessionId(client);
	if (options.signal) {
		bindStreamSignal(client, options.signal);
	}
	defineMethod(client.agents, "iterate", (query?: ManagedAgentIterateQuery) =>
		iterateAgents(client, query)
	);
	defineMethod(
		client.environments,
		"iterate",
		(query?: ManagedAgentEnvironmentIterateQuery) =>
			iterateEnvironments(client, query)
	);
	defineMethod(
		client.sessions,
		"iterate",
		(query?: ManagedAgentSessionIterateQuery) => iterateSessions(client, query)
	);
	defineMethod(
		client.sessions,
		"follow",
		(sessionId: string, followOptions?: ManagedAgentFollowOptions) =>
			followSession(client, sessionId, followOptions)
	);
	defineMethod(
		client.sessions,
		"approveTool",
		(
			sessionId: string,
			toolUseId: string,
			answerOptions?: ManagedAgentToolAnswerOptions
		) =>
			answerToolApproval(client, sessionId, toolUseId, "allow", answerOptions)
	);
	defineMethod(
		client.sessions,
		"denyTool",
		(
			sessionId: string,
			toolUseId: string,
			answerOptions?: ManagedAgentToolAnswerOptions
		) => answerToolApproval(client, sessionId, toolUseId, "deny", answerOptions)
	);
	defineMethod(
		client.sessions,
		"respondToApproval",
		(
			sessionId: string,
			toolUseId: string,
			decision: "allow" | "deny",
			answerOptions?: ManagedAgentToolAnswerOptions
		) =>
			answerToolApproval(client, sessionId, toolUseId, decision, answerOptions)
	);
	defineMethod(
		client.sessions,
		"run",
		(
			input: ManagedAgentSessionRunInput,
			runOptions?: ManagedAgentSessionRunOptions
		) =>
			runSession(client, input, runOptions, {
				linkSignal: linker.linkSignal,
			})
	);
	return client as ManagedAgentsNamespace;
}

/** How the facade wraps Managed Agents. */
export const MANAGED_AGENTS_NAMESPACE: NamespaceDefinition<ManagedAgentsNamespace> =
	{
		create: createManagedAgentsNamespace,
		decorateError: decorateManagedAgentsError,
		errors: "passthrough",
		routes: MANAGED_AGENTS_ROUTES,
		service: "managedAgents",
	};
