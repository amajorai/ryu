// packages/services/src/notify/helpers.ts
//
// `ryu.notify.requestApproval()`: publish an interactive event whose
// `response.type` is `approval` (or `yes_no`), then poll `GET /v1/events/:id`
// until someone answers, the response is canceled, or it expires.
//
// The event is published with `response.expiresAt` set to the deadline, so
// Notify itself expires the request: an answer that arrives after the
// deadline is refused with `409 conflict` instead of being recorded silently.
// The helper runs inside one facade call, so the publish and every poll share
// that call's fetch shim: the call's `idempotencyKey` reaches the publish,
// and retries, timeouts and typed errors apply to each request.

import type {
	NotificationEvent,
	NotificationResponseStatus,
	NotifyAPI,
	NotifyEventInput,
} from "@ryuhq/client";
import {
	RyuInvalidRequestError,
	RyuResponseValidationError,
} from "../errors.ts";
import { linkSignals } from "../transport/fetch-shim.ts";

/** Default wait for an answer: 10 minutes. */
export const DEFAULT_APPROVAL_TIMEOUT_MS = 600_000;
/** Default delay between polls. */
export const DEFAULT_APPROVAL_POLL_INTERVAL_MS = 2000;
/** The shortest poll interval the helper accepts, so it never hammers the server. */
export const MIN_APPROVAL_POLL_INTERVAL_MS = 250;
/**
 * The longest `timeoutMs` or `pollIntervalMs` the helper accepts: 2^31-1 ms
 * (about 24.8 days), the largest delay timers honour; larger values would
 * fire almost at once.
 */
export const MAX_APPROVAL_DURATION_MS = 2_147_483_647;

/** The interaction kinds an approval can use. */
export type NotifyApprovalType = "approval" | "yes_no";

/** `requestApproval()` input: a publish body without `response`, plus the interaction settings. */
export interface NotifyApprovalInput
	extends Omit<NotifyEventInput, "response"> {
	/** Optional HMAC key for `callbackUrl`; Notify stores it privately. */
	callbackSecret?: string;
	/** Notify also POSTs the answer here (signed when `callbackSecret` is set). */
	callbackUrl?: string;
	/** The question shown with the event. */
	prompt?: string;
	/** `approval` (approved or denied, the default) or `yes_no`. */
	responseType?: NotifyApprovalType;
	/**
	 * How long to wait for an answer, in ms. Also sent as `response.expiresAt`,
	 * so Notify expires the request at the same moment. Default 600 000, at
	 * most 2 147 483 647.
	 */
	timeoutMs?: number;
}

/** `requestApproval()` options. */
export interface NotifyApprovalOptions {
	/**
	 * For the publish; the SDK adds one when omitted. `.with({ idempotencyKey })` also works.
	 * It covers the SDK's own HTTP retries (they resend the same body). Calling
	 * `requestApproval()` again with the same key does not replay the first
	 * request: the new call sends a later `response.expiresAt`, so Notify answers
	 * `409 idempotency_conflict`; read the first event with `events.get()` instead.
	 */
	idempotencyKey?: string;
	/** Called once with the published event, before the first poll. */
	onPublished?(event: NotificationEvent): void;
	/** Delay between polls in ms. Default 2000, at least 250, at most 2 147 483 647. */
	pollIntervalMs?: number;
	/**
	 * Aborting cancels the in-flight publish or poll and stops waiting with
	 * RyuAbortError. A published event stays pending until it expires.
	 */
	signal?: AbortSignal;
	/**
	 * Stop waiting after this many ms, even though the request stays open
	 * until `timeoutMs`; the result is then `status: "pending"` with
	 * `timedOut: false`, and `events.get(event.id)` reads the answer later.
	 * Default: wait until `timeoutMs`. At most 2 147 483 647.
	 */
	waitMs?: number;
}

/** What `requestApproval()` resolves to. */
export interface NotifyApprovalResult {
	/** True for `approved` (approval) or `yes` (yes/no). */
	approved: boolean;
	/** The event as last read. */
	event: NotificationEvent;
	/**
	 * The stored response status: `approved`, `denied`, `yes`, `no`,
	 * `expired`, `canceled`, or `pending`. `pending` with `timedOut: true`
	 * means the deadline passed before Notify recorded the expiry; with
	 * `timedOut: false` it means `waitMs` ended while the request is still open.
	 */
	status: NotificationResponseStatus;
	/** True when nobody answered before the deadline (`timeoutMs`). */
	timedOut: boolean;
	/** The answer's optional value. */
	value: string | null;
}

/** What the helper needs from the per-call environment. */
export interface ApprovalRuntime {
	/** The call's own signal (from `.with({ signal })`), if any. */
	callSignal?: AbortSignal;
	/** Clock in ms; injectable for tests. */
	now?: () => number;
	/** Waits `ms`, rejecting when `signal` aborts; injectable for tests. */
	sleep?: (ms: number, signal: AbortSignal | undefined) => Promise<void>;
}

const APPROVED_STATUSES: ReadonlySet<NotificationResponseStatus> = new Set([
	"approved",
	"yes",
]);

function abortError(signal: AbortSignal): Error {
	const reason: unknown = signal.reason;
	if (reason instanceof Error && reason.name === "AbortError") {
		return reason;
	}
	const error = new Error("Ryu notify.requestApproval was aborted.");
	error.name = "AbortError";
	return error;
}

function defaultSleep(
	ms: number,
	signal: AbortSignal | undefined
): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(abortError(signal));
			return;
		}
		const onAbort = () => {
			clearTimeout(timer);
			if (signal) {
				reject(abortError(signal));
			}
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

function invalid(code: string, message: string): RyuInvalidRequestError {
	return new RyuInvalidRequestError({
		service: "notify",
		status: 0,
		code,
		message: `Ryu notify.requestApproval: ${message}`,
		retryable: false,
	});
}

function positiveMs(
	value: number | undefined,
	fallback: number,
	name: string
): number {
	if (value === undefined) {
		return fallback;
	}
	if (!Number.isFinite(value) || value <= 0) {
		throw invalid(
			"invalid_timeout",
			`${name} must be a positive number of ms.`
		);
	}
	if (value > MAX_APPROVAL_DURATION_MS) {
		throw invalid(
			"invalid_timeout",
			`${name} must be at most ${MAX_APPROVAL_DURATION_MS} ms.`
		);
	}
	return value;
}

function settle(
	event: NotificationEvent,
	deadlinePassed: boolean
): NotifyApprovalResult | null {
	const response = event.response;
	if (response === null) {
		throw new RyuResponseValidationError({
			service: "notify",
			status: 200,
			code: "invalid_response",
			message:
				"Ryu notify.requestApproval: the event came back without its response object.",
		});
	}
	if (response.status === "pending" && !deadlinePassed) {
		return null;
	}
	return {
		approved: APPROVED_STATUSES.has(response.status),
		event,
		status: response.status,
		timedOut: response.status === "expired" || response.status === "pending",
		value: response.value,
	};
}

/**
 * Publishes an approval request and waits for the answer. See
 * {@link NotifyApprovalInput} and {@link NotifyApprovalOptions}.
 */
export async function requestApproval(
	client: Pick<NotifyAPI, "getEvent" | "publish">,
	input: NotifyApprovalInput,
	options: NotifyApprovalOptions = {},
	runtime: ApprovalRuntime = {}
): Promise<NotifyApprovalResult> {
	const {
		callbackSecret,
		callbackUrl,
		prompt,
		responseType = "approval",
		timeoutMs,
		...event
	} = input;
	if (responseType !== "approval" && responseType !== "yes_no") {
		throw invalid(
			"invalid_response_type",
			"responseType must be approval or yes_no."
		);
	}
	const timeout = positiveMs(
		timeoutMs,
		DEFAULT_APPROVAL_TIMEOUT_MS,
		"timeoutMs"
	);
	const pollInterval = Math.max(
		MIN_APPROVAL_POLL_INTERVAL_MS,
		positiveMs(
			options.pollIntervalMs,
			DEFAULT_APPROVAL_POLL_INTERVAL_MS,
			"pollIntervalMs"
		)
	);
	const wait =
		options.waitMs === undefined
			? timeout
			: Math.min(timeout, positiveMs(options.waitMs, timeout, "waitMs"));
	const signals = [options.signal, runtime.callSignal].filter(
		(signal): signal is AbortSignal => signal !== undefined
	);
	const linked = linkSignals(signals);
	try {
		return await waitForAnswer(client, {
			callbackSecret,
			callbackUrl,
			event,
			idempotencyKey: options.idempotencyKey,
			onPublished: options.onPublished,
			pollInterval,
			prompt,
			responseType,
			signal: linked.signal,
			timeout,
			wait,
			now: runtime.now ?? Date.now,
			sleep: runtime.sleep ?? defaultSleep,
		});
	} finally {
		linked.dispose();
	}
}

interface ApprovalPlan {
	callbackSecret: string | undefined;
	callbackUrl: string | undefined;
	event: Omit<NotifyEventInput, "response">;
	idempotencyKey: string | undefined;
	now: () => number;
	onPublished: ((event: NotificationEvent) => void) | undefined;
	pollInterval: number;
	prompt: string | undefined;
	responseType: NotifyApprovalType;
	signal: AbortSignal | undefined;
	sleep: (ms: number, signal: AbortSignal | undefined) => Promise<void>;
	timeout: number;
	wait: number;
}

async function waitForAnswer(
	client: Pick<NotifyAPI, "getEvent" | "publish">,
	plan: ApprovalPlan
): Promise<NotifyApprovalResult> {
	const { now, signal, sleep } = plan;
	if (signal?.aborted) {
		throw abortError(signal);
	}
	const startedAt = now();
	const deadline = startedAt + plan.timeout;
	const stopWaitingAt = startedAt + plan.wait;
	const response: NonNullable<NotifyEventInput["response"]> = {
		type: plan.responseType,
		expiresAt: new Date(deadline).toISOString(),
	};
	if (plan.prompt !== undefined) {
		response.prompt = plan.prompt;
	}
	if (plan.callbackUrl !== undefined) {
		response.callbackUrl = plan.callbackUrl;
	}
	if (plan.callbackSecret !== undefined) {
		response.callbackSecret = plan.callbackSecret;
	}
	const published = await client.publish(
		{ ...plan.event, response },
		plan.idempotencyKey
	);
	plan.onPublished?.(published);
	const first = settle(published, false);
	if (first) {
		return first;
	}
	while (true) {
		const remaining = stopWaitingAt - now();
		await sleep(Math.max(0, Math.min(plan.pollInterval, remaining)), signal);
		const deadlinePassed = now() >= deadline;
		const current = await client.getEvent(published.id);
		const result = settle(current, deadlinePassed);
		if (result) {
			return result;
		}
		if (now() >= stopWaitingAt) {
			return {
				approved: false,
				event: current,
				status: "pending",
				timedOut: false,
				value: null,
			};
		}
	}
}
