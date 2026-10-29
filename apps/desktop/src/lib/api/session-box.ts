// apps/desktop/src/lib/api/session-box.ts
//
// Typed client for a conversation's session Box (`/api/session-boxes/{id}`).
// Heavy work in a conversation (a cloud task, computer use, the browser, a
// parallel sub-agent) runs on a Box of its own with its own screen. Core owns
// the Box: it creates, parks, resumes and meters it, and it alone holds the Box
// service credential. The desktop is a projection: it reads status and cost,
// asks Core for a screen grant, and parks or resumes through Core.
//
// Every status field is parsed optional-tolerant. An older Core that predates a
// field (or the whole `box` object) still parses, and an unknown enum value
// degrades to `null` instead of hiding the panel. A malformed top-level body is
// still an error.
//
// Computer use starts a paid session Box. The first time for each person Core
// holds that Box until they acknowledge its hourly cost: the status then
// carries `costNotice` (`waiting` while the agent's call is held), and
// `acknowledgeSessionBoxCost` records the answer. Settings can read and give
// the same acknowledgement ahead of any conversation
// (`fetchSessionBoxCostNoticeState`, `acknowledgeSessionBoxCostAhead`).
//
// Screen grants come in two modes:
// - `direct` (hosted): an absolute `wss://` URL on the Box ingress plus the
//   WebSocket subprotocols that carry a single-use token. Video never crosses
//   the node.
// - `relay` (self-hosted): a Core path; the client takes a one-use Core ticket
//   bound to that path and dials Core, which bridges to the Box.

import {
	type DesktopGrant,
	parseDesktopGrant,
	parseExtendedDeadline,
	parseSessionBoxCostNoticeState,
	parseSessionBoxStatus,
	type SessionBoxCostNoticeState,
	type SessionBoxEndpoint,
	type SessionBoxStatus,
	sessionBoxRefusalText,
} from "@ryu/blocks/session-box/wire.ts";
import { ApiError, type ApiTarget, apiUrl, request } from "./client.ts";
import { gatewayJsonValueSchema } from "./gateway-json-contracts.ts";

export {
	COST_NOTICE_REQUIRED_CODE,
	type DesktopGrant,
	parseDesktopGrant,
	parseSessionBoxCaps,
	parseSessionBoxCostNotice,
	parseSessionBoxStatus,
	parseSessionBoxView,
	type SessionBoxCaps,
	type SessionBoxCostNotice,
	type SessionBoxCostNoticeState,
	type SessionBoxDesktop,
	type SessionBoxEndpoint,
	type SessionBoxPlacement,
	type SessionBoxSize,
	type SessionBoxSource,
	type SessionBoxState,
	type SessionBoxStatus,
	type SessionBoxStopReason,
	type SessionBoxView,
	type SessionBoxWarning,
	sessionBoxKey,
} from "@ryu/blocks/session-box/wire.ts";

function boxPath(key: string, suffix = ""): string {
	return `/api/session-boxes/${encodeURIComponent(key)}${suffix}`;
}

/** Read a conversation's session Box. Null when Core has none for this owner. */
export async function fetchSessionBox(
	target: ApiTarget,
	conversationId: string,
	signal?: AbortSignal
): Promise<SessionBoxStatus | null> {
	try {
		const raw = await request<unknown>(
			target,
			boxPath(conversationId),
			{ signal },
			gatewayJsonValueSchema
		);
		return parseSessionBoxStatus(raw);
	} catch (error) {
		if (error instanceof ApiError && error.status === 404) {
			return null;
		}
		throw error;
	}
}

export interface ScreenRequestOptions {
	/** The page origin, for a client whose requests carry no `Origin` header. */
	origin?: string | null;
	signal?: AbortSignal;
	viewOnly?: boolean;
}

/** Ask Core for a screen grant (`POST …/screen`). Resumes a parked Box. */
export async function requestSessionBoxScreen(
	target: ApiTarget,
	key: string,
	options: ScreenRequestOptions = {}
): Promise<DesktopGrant> {
	const body: { origin?: string; viewOnly: boolean } = {
		viewOnly: options.viewOnly === true,
	};
	if (options.origin) {
		body.origin = options.origin;
	}
	const raw = await request<unknown>(
		target,
		boxPath(key, "/screen"),
		{ method: "POST", body, signal: options.signal },
		gatewayJsonValueSchema
	);
	return parseDesktopGrant(raw);
}

/** Take a one-use Core WebSocket ticket bound to a session-box relay path. */
export async function requestSessionBoxTicket(
	target: ApiTarget,
	path: string,
	signal?: AbortSignal
): Promise<string> {
	const raw = await request<unknown>(
		target,
		"/api/ws/ticket",
		{ method: "POST", body: { route: "session-box", path }, signal },
		gatewayJsonValueSchema
	);
	const ticket =
		typeof raw === "object" && raw !== null && "ticket" in raw
			? raw.ticket
			: null;
	if (typeof ticket !== "string" || ticket.trim() === "") {
		throw new Error("Core returned an invalid WebSocket ticket");
	}
	return ticket;
}

/** The Core relay URL for a ticketed relay grant. */
export function sessionBoxRelayUrl(
	target: ApiTarget,
	path: string,
	ticket: string,
	viewOnly: boolean
): string {
	const url = new URL(apiUrl(target, path));
	url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
	url.searchParams.set("ticket", ticket);
	if (viewOnly) {
		url.searchParams.set("viewOnly", "1");
	}
	return url.toString();
}

/**
 * Mint a dialable screen endpoint: a direct grant is used verbatim; a relay
 * grant is exchanged for a Core ticket. Called again on every reconnect, since
 * tokens and tickets are single-use.
 */
export async function connectSessionBoxScreen(
	target: ApiTarget,
	key: string,
	options: ScreenRequestOptions = {}
): Promise<SessionBoxEndpoint> {
	const grant = await requestSessionBoxScreen(target, key, options);
	if (grant.mode === "direct") {
		return { url: grant.url, protocols: grant.protocols };
	}
	const ticket = await requestSessionBoxTicket(
		target,
		grant.path,
		options.signal
	);
	return {
		url: sessionBoxRelayUrl(
			target,
			grant.path,
			ticket,
			options.viewOnly === true
		),
		protocols: [],
	};
}

async function post(target: ApiTarget, path: string, body?: unknown) {
	return await request<unknown>(
		target,
		path,
		{ method: "POST", body },
		gatewayJsonValueSchema.optional()
	);
}

/** Park the Box (`POST …/stop`). Its state is saved; the next call resumes it. */
export async function stopSessionBox(
	target: ApiTarget,
	key: string
): Promise<void> {
	await post(target, boxPath(key, "/stop"));
}

/** Resume a parked Box (`POST …/resume`). */
export async function resumeSessionBox(
	target: ApiTarget,
	key: string
): Promise<void> {
	await post(target, boxPath(key, "/resume"));
}

/** Extend the Box's lifetime (`POST …/extend`). Returns the new deadline. */
export async function extendSessionBox(
	target: ApiTarget,
	key: string,
	seconds?: number
): Promise<string | null> {
	const raw = await post(
		target,
		boxPath(key, "/extend"),
		seconds === undefined ? {} : { seconds }
	);
	return parseExtendedDeadline(raw);
}

/**
 * Acknowledge the one-time computer-use Box cost (`POST …/cost-notice`),
 * echoing the hourly rate the notice showed. Core answers 409
 * `session_box_rate_changed` when the rate moved, and the next status shows
 * the new one.
 */
export async function acknowledgeSessionBoxCost(
	target: ApiTarget,
	conversationId: string,
	ratePerHourMicroUsd: number
): Promise<void> {
	await post(target, boxPath(conversationId, "/cost-notice"), {
		ratePerHourMicroUsd,
	});
}

/** Readable text for a session Box refusal, by Core's error code. */
export function sessionBoxErrorMessage(error: unknown): string {
	if (error instanceof ApiError) {
		return (
			sessionBoxRefusalText(error.code) ?? error.serverMessage ?? error.message
		);
	}
	return error instanceof Error ? error.message : "The Box request failed.";
}

const OWNER_COST_NOTICE_PATH = "/api/session-boxes/cost-notice";

/**
 * The caller's computer-use cost acknowledgement and the rate it would be
 * asked for. Null when this Core predates the route (404) or the caller may
 * not use session Boxes (403).
 */
export async function fetchSessionBoxCostNoticeState(
	target: ApiTarget,
	signal?: AbortSignal
): Promise<SessionBoxCostNoticeState | null> {
	try {
		const raw = await request<unknown>(
			target,
			OWNER_COST_NOTICE_PATH,
			{ signal },
			gatewayJsonValueSchema
		);
		return parseSessionBoxCostNoticeState(raw);
	} catch (error) {
		if (
			error instanceof ApiError &&
			(error.status === 404 || error.status === 403)
		) {
			return null;
		}
		throw error;
	}
}

/**
 * Acknowledge the computer-use Box cost ahead of any conversation, echoing
 * the rate shown (409 `session_box_rate_changed` when it moved).
 */
export async function acknowledgeSessionBoxCostAhead(
	target: ApiTarget,
	ratePerHourMicroUsd: number
): Promise<void> {
	await post(target, OWNER_COST_NOTICE_PATH, { ratePerHourMicroUsd });
}
