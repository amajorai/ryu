// The host-side gate in front of `ui.openExternal`.
//
// `ui.openExternal` needs no grant, so any app frame can ask the shell to open
// an http(s) address in the person's browser. This gate makes the shell ask the
// person first, with a prompt the HOST draws outside the frame, and limits how
// often one frame may raise that prompt. It holds no UI: the shell supplies
// `confirm`, and the opener runs only after `confirm` answers true.

import { CodedRpcError } from "./rpc-errors.ts";

/** Prompts one app frame may raise inside {@link OPEN_EXTERNAL_WINDOW_MS}. */
export const OPEN_EXTERNAL_MAX_PROMPTS = 5;
/** The rolling window of the per-frame prompt limit. */
export const OPEN_EXTERNAL_WINDOW_MS = 60_000;
/** Longest path, query and fragment shown after the host name. */
export const OPEN_EXTERNAL_REST_LIMIT = 80;
/** Longest app name shown in the prompt. */
export const OPEN_EXTERNAL_APP_NAME_LIMIT = 60;

/** What the shell shows for one address. Built from the vetted URL only, so no
 *  text of the app reaches the prompt through it. */
export interface ExternalDestination {
	/** `scheme://host` then {@link rest}: the whole line the prompt shows. */
	display: string;
	/** The full host name, with its port when the address has one. Never
	 *  shortened; an internationalized name stays in its `xn--` form. */
	host: string;
	/** The exact address handed to the opener after a yes. */
	href: string;
	/** Path, query and fragment, cut at the END only when long. */
	rest: string;
	scheme: "http" | "https";
}

/** Asks the person. A yes answers the destination the prompt showed, and its
 *  `href` is what opens; false and a rejection open nothing. */
export type OpenExternalAsk = (input: {
	href: string;
}) => Promise<ExternalDestination | false>;

/** One prompt at a time for every frame that shares a lock. */
export interface OpenExternalPromptLock {
	open: boolean;
}

/** The lock of this shell document: a second frame cannot stack a prompt on
 *  top of the one the person is reading. */
const SHELL_PROMPT_LOCK: OpenExternalPromptLock = { open: false };

const CONTROL_OR_FORMAT = /[\p{Cc}\p{Cf}]+/gu;
const WHITESPACE_RUN = /\s+/gu;

/**
 * Describe an address for the prompt, or null when it must not open: not
 * http(s), or carrying a user name or password (`https://bank.example@evil.example`
 * reads like the first name and opens the second).
 */
export function describeExternalDestination(
	href: string
): ExternalDestination | null {
	let url: URL;
	try {
		url = new URL(href);
	} catch {
		return null;
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") {
		return null;
	}
	if (url.username !== "" || url.password !== "" || url.host === "") {
		return null;
	}
	const scheme = url.protocol === "https:" ? "https" : "http";
	const tail = `${url.pathname}${url.search}${url.hash}`;
	const whole = tail === "/" ? "" : tail;
	const rest =
		whole.length > OPEN_EXTERNAL_REST_LIMIT
			? `${whole.slice(0, OPEN_EXTERNAL_REST_LIMIT)}…`
			: whole;
	return {
		display: `${scheme}://${url.host}${rest}`,
		host: url.host,
		href: url.href,
		rest,
		scheme,
	};
}

/** The app's own name as the prompt may show it: one line, no control or
 *  direction characters, cut when long. The app chose this text. */
export function promptAppName(name: string): string {
	const plain = name
		.replace(CONTROL_OR_FORMAT, " ")
		.replace(WHITESPACE_RUN, " ")
		.trim();
	return plain.length > OPEN_EXTERNAL_APP_NAME_LIMIT
		? `${plain.slice(0, OPEN_EXTERNAL_APP_NAME_LIMIT)}…`
		: plain;
}

/**
 * Build the asking half of the gate for ONE app frame. It refuses, without a
 * prompt, when a prompt is already open or when this frame raised
 * {@link OPEN_EXTERNAL_MAX_PROMPTS} prompts inside the window. Every prompt
 * counts, whatever the person answered.
 */
export function createOpenExternalAsk({
	confirm,
	lock = SHELL_PROMPT_LOCK,
	maxPrompts = OPEN_EXTERNAL_MAX_PROMPTS,
	now = Date.now,
	windowMs = OPEN_EXTERNAL_WINDOW_MS,
}: {
	confirm: (destination: ExternalDestination) => Promise<boolean>;
	lock?: OpenExternalPromptLock;
	maxPrompts?: number;
	now?: () => number;
	windowMs?: number;
}): OpenExternalAsk {
	let prompts: number[] = [];
	return async ({ href }) => {
		const destination = describeExternalDestination(href);
		if (!destination) {
			throw new CodedRpcError(
				"invalid_args",
				"ui.openExternal requires an http(s) URL without credentials"
			);
		}
		if (lock.open) {
			throw new CodedRpcError(
				"over_budget",
				"ui.openExternal is waiting for an answer to an earlier link"
			);
		}
		const at = now();
		prompts = prompts.filter((earlier) => at - earlier < windowMs);
		if (prompts.length >= maxPrompts) {
			throw new CodedRpcError(
				"over_budget",
				"ui.openExternal asked too often, try again later"
			);
		}
		prompts.push(at);
		lock.open = true;
		try {
			return (await confirm(destination)) === true ? destination : false;
		} finally {
			lock.open = false;
		}
	};
}

/**
 * Put the gate in front of a shell opener. The opener runs only after a yes,
 * and it receives the `href` of the destination `ask` answered (the address
 * the prompt showed), never the string the frame sent: the two can differ
 * where the URL parser drops or rewrites a character. A missing `ask` refuses
 * every call, so a host that forgets to wire the prompt cannot open links
 * silently, and so does a yes that carries no address.
 */
export function gateOpenExternal(
	ask: OpenExternalAsk | undefined,
	open: (input: { href: string }) => Promise<void> | void
): (input: { href: string }) => Promise<void> {
	return async (input) => {
		if (!ask) {
			throw new CodedRpcError(
				"server_error",
				"ui.openExternal is not available"
			);
		}
		const destination = await ask(input);
		const href = destination ? destination.href : undefined;
		if (typeof href !== "string") {
			throw new CodedRpcError("denied", "The link was not opened");
		}
		await open({ href });
	};
}
