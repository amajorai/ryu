// apps/desktop/src/lib/api/widgets.ts
//
// The PRIVILEGED, host-side client for the governed widget round-trips (Ryu Apps).
// The widget iframe runs at a null origin and NEVER holds the Core node token; the
// trusted desktop host (AppWidget) performs these fetches on its behalf, over the
// governed Core routes that transit the full Gateway chain (decisions doc D5):
//
//   - widgetCallTool  -> POST /api/widgets/tools/call   (provenance -> scan -> budget -> forward -> audit)
//   - widgetFollowUp  -> POST /api/widgets/follow-up    (binding + grant + firewall + rate-limit)
//   - widgetSetState  -> POST /api/widgets/state        (best-effort server persistence, D4)
//
// Identity the frame supplies is MINIMAL and echoed only: `instanceId` (round-trip
// identity minted by Core at emit), `toolCallId`, `serverId` (pinned by the host,
// never frame-supplied), `tool_id`, and `arguments`. `agent_id`/`origin_server`
// are resolved server-side from the instance record (spec §4.1), never trusted
// from the client.

import {
	CodedRpcError,
	type RpcJsonResponse,
	type RyuJsonValue,
	rpcJsonResponseSchema,
	type WidgetRpcErrorCode,
	widgetRpcErrorCodeSchema,
} from "@ryu/app-host/rpc";
import type { WidgetMessageAttribution } from "@ryu/blocks/desktop/agent-elements/types.ts";
import { type ApiTarget, authenticatedFetch } from "./client.ts";
import {
	type WidgetWireRequest,
	widgetErrorBodySchema,
	widgetErrorStringSchema,
	widgetFollowUpResultSchema,
	widgetNestedErrorSchema,
	widgetToolResultSchema,
	widgetWireRequestSchema,
} from "./widget-wire-contracts.ts";

/** Map an HTTP status to a widget error code when the response body carries none
 *  (defense so the widget always sees a closed code, D6). */
function codeForStatus(status: number): WidgetRpcErrorCode {
	if (status === 403) {
		return "denied";
	}
	if (status === 404) {
		return "not_found";
	}
	if (status === 429) {
		return "over_budget";
	}
	if (status === 400 || status === 422) {
		return "invalid_args";
	}
	return "server_error";
}

/** Parse a non-2xx widget response into a {@link CodedRpcError}. Accepts either
 *  `{ error: { code, message } }`, a bare `{ code, message }`, or `{ error: string }`,
 *  falling back to a status-derived code (D6 closed enum). */
async function toCodedError(
	resp: Response,
	fallbackMessage: string
): Promise<CodedRpcError> {
	let code: WidgetRpcErrorCode = codeForStatus(resp.status);
	let message = fallbackMessage;
	try {
		const text = await resp.text();
		if (text) {
			const body = widgetErrorBodySchema.safeParse(JSON.parse(text));
			if (body.success) {
				const nested = widgetNestedErrorSchema.safeParse(body.data.error);
				const error = nested.success ? nested.data : body.data;
				if (error.code !== undefined) {
					const parsedCode = widgetRpcErrorCodeSchema.safeParse(error.code);
					code = parsedCode.success ? parsedCode.data : "server_error";
				}
				const legacyMessage = widgetErrorStringSchema.safeParse(
					body.data.error
				);
				if (error.message !== undefined) {
					message = error.message;
				} else if (legacyMessage.success) {
					message = legacyMessage.data;
				}
			}
		}
	} catch {
		// Non-JSON error body — keep the status-derived code + fallback message.
	}
	return new CodedRpcError(code, message);
}

/** POST a JSON body to a governed widget route, returning the parsed JSON (or
 *  `undefined` for an empty body). Throws a {@link CodedRpcError} on non-2xx. */
async function postWidget(
	target: ApiTarget,
	path: string,
	body: WidgetWireRequest
): Promise<RpcJsonResponse> {
	const resp = await authenticatedFetch(target, path, {
		method: "POST",
		body: JSON.stringify(widgetWireRequestSchema.parse(body)),
	});
	if (!resp.ok) {
		throw await toCodedError(resp, `${path} failed: ${resp.status}`);
	}
	const text = await resp.text();
	return rpcJsonResponseSchema.parse(text ? JSON.parse(text) : undefined);
}

/** The identifiers a governed tool call echoes back (spec §4.1). `serverId` is
 *  pinned by the host from the stream part, never supplied by the frame. */
export interface WidgetCallToolInput {
	args: RpcJsonResponse;
	instanceId: string;
	name: string;
	serverId: string;
	toolCallId: string;
}

/** Core's response to a governed widget tool call (spec §3.2 item 9). */
export interface WidgetCallToolResult {
	ok: boolean;
	output: RyuJsonValue;
}

/**
 * Invoke a tool ON THE WIDGET'S BEHALF through the governed Gateway chain. The
 * host holds the Core token and pins `serverId`; Core's provenance gate re-derives
 * `origin_server`/`agent_id` from the instance record, so a compromised frame
 * cannot call another server's tool or impersonate another agent (D5).
 */
export function widgetCallTool(
	target: ApiTarget,
	input: WidgetCallToolInput
): Promise<WidgetCallToolResult> {
	return postWidget(target, "/api/widgets/tools/call", {
		instance_id: input.instanceId,
		server_id: input.serverId,
		tool_id: input.name,
		tool_call_id: input.toolCallId,
		arguments: input.args,
	}).then(widgetToolResultSchema.parse);
}

/** The identifiers a governed follow-up echoes back (spec §4.2). */
export interface WidgetFollowUpInput {
	instanceId: string;
	prompt: string;
	toolCallId: string;
}

export interface WidgetInjectedTurn {
	conversation_id: string;
	origin_server: string;
	prompt: string;
	role: "user";
	source: "widget";
	tool_call_id: string | null;
	widget_instance_id: string;
}

export interface WidgetFollowUpResult {
	injected: WidgetInjectedTurn;
	ok: true;
	ticket: string;
}

/**
 * Inject a widget-attributed user turn on the owning conversation through the
 * governed follow-up route (R4/D5). Core gates it (binding + `chat.sendFollowUp`
 * grant + firewall/DLP + rate-limit) and tags it `source:"widget"`; the injected
 * turn streams back through the normal chat transport.
 */
export async function widgetFollowUp(
	target: ApiTarget,
	input: WidgetFollowUpInput
): Promise<WidgetFollowUpResult> {
	const result = await postWidget(target, "/api/widgets/follow-up", {
		instance_id: input.instanceId,
		tool_call_id: input.toolCallId,
		prompt: input.prompt,
	});
	const parsed = widgetFollowUpResultSchema.safeParse(result);
	if (!parsed.success) {
		throw new Error("Core returned an invalid widget follow-up envelope");
	}
	return parsed.data;
}

/**
 * Submit the already-governed widget prompt through the normal chat transport.
 * The callback is the page's `useChat.sendMessage`, so its transport body keeps
 * the current conversation, agent, model, and other turn context intact.
 */
export async function submitWidgetFollowUp(
	target: ApiTarget,
	input: WidgetFollowUpInput,
	sendMessage: (
		message: { metadata?: WidgetMessageAttribution; text: string },
		options: { body: { widget_follow_up_ticket: string } }
	) => Promise<void>
): Promise<void> {
	const result = await widgetFollowUp(target, input);
	await sendMessage(
		{
			metadata: {
				origin_server: result.injected.origin_server,
				source: "widget",
				widget_instance_id: result.injected.widget_instance_id,
			},
			text: result.injected.prompt,
		},
		{ body: { widget_follow_up_ticket: result.ticket } }
	);
}

/** The identifiers a state write echoes back (decisions doc D4). */
export interface WidgetSetStateInput {
	instanceId: string;
	state: RpcJsonResponse;
	toolCallId: string;
}

/**
 * Best-effort server-side persistence of widget state (D4). The client Zustand
 * mirror ({@link useWidgetStateStore}) is authoritative for the live session; this
 * write lets the state survive a full reload. Failures are swallowed by the caller
 * — a dropped state write never blocks the widget.
 */
export async function widgetSetState(
	target: ApiTarget,
	input: WidgetSetStateInput
): Promise<void> {
	await postWidget(target, "/api/widgets/state", {
		instance_id: input.instanceId,
		tool_call_id: input.toolCallId,
		state: input.state,
	});
}
