// packages/services/src/box/helpers.ts
//
// `box.run()`: create a Box, wait until it leaves `provisioning`, then run one
// command in it and wait for the command to finish. It runs inside one facade
// call, so every request shares that call's fetch shim:
//
// - the `POST /v1/boxes` carries one Idempotency-Key for all of its retries:
//   the caller's (`options.idempotencyKey`, or `.with({ idempotencyKey })`),
//   else the one the Box client generates, which the shim keeps;
// - the wait polls `GET /v1/boxes/{id}` and stops on the call's signal;
// - the command is the streamed `POST /v1/boxes/{id}/commands`, collected
//   into one result. The plain route sends no headers until the command
//   ends, so a command longer than the call's `timeoutMs` (default 60 s)
//   would time out while it kept running on the server; the stream answers
//   at once, and closing it (abort) stops the command. The route is not
//   idempotent, so it is not replayed on a 5xx and a command never runs
//   twice because of an SDK retry.
//
// Unlike the client's `waitUntilReady()`, a failed or slow Box raises a
// RyuError (`box_failed`, `box_ready_timeout`) that carries the Box id, so
// the caller can inspect or delete it. `box.run()` never deletes the Box.

import type {
	Box,
	BoxAPI,
	BoxCommandInput,
	BoxExecResult,
	BoxStreamEvent,
	CreateBoxInput,
	RyuFetch,
} from "@ryuhq/client";
import {
	RyuAbortError,
	RyuConfigurationError,
	RyuConnectionError,
	RyuError,
	RyuTimeoutError,
} from "../errors.ts";
import { newIdempotencyKey } from "../transport/idempotency.ts";
import { BOX_RUN_CODES } from "./codes.ts";

/**
 * `box.run()` input: the `box.create()` body (without a required `name`) plus
 * the command to run once the Box is ready. `env` is the Box's environment,
 * which every command in it sees, this one included.
 */
export interface BoxRunInput
	extends Omit<CreateBoxInput, "name">,
		Omit<BoxCommandInput, "command" | "env"> {
	/**
	 * The program to run. No shell runs it unless you start one
	 * (`["sh", "-c", "…"]`), so pipes and globs are not expanded.
	 *
	 * - A string is a command line that the Box service splits into words
	 *   like a shell would: whitespace separates words, quotes and `\`
	 *   group or escape them (`"node -v"` runs `node` with `-v`;
	 *   `"'/opt/my app/run'"` runs one path with a space). `args` are added
	 *   after those words, verbatim.
	 * - An array is the executable followed by its arguments, each one
	 *   verbatim: the SDK quotes the executable so the service does not split
	 *   it, and the arguments are sent as `args`. It must not be combined
	 *   with `args`.
	 */
	command: string | readonly string[];
	/**
	 * Box name. Default `run-<hex>`: derived from the idempotency key when
	 * one is given (so retrying `box.run()` with the same key replays the
	 * same create), random otherwise.
	 */
	name?: string;
}

/** Options for `box.run()`. */
export interface BoxRunOptions {
	/**
	 * For the `POST /v1/boxes`; one key is used for all of its retries.
	 * `.with({ idempotencyKey })` also works. Calling `box.run()` again with
	 * the same key and input replays the first create (200) instead of
	 * making a second Box.
	 */
	idempotencyKey?: string;
	/** How often to poll while the Box is provisioning, in ms. Default 1000. */
	pollIntervalMs?: number;
	/** How long to wait for the Box to leave `provisioning`, in ms. Default 30 minutes. */
	readyTimeoutMs?: number;
	/** Aborting stops the run with RyuAbortError. The Box is left as it is. */
	signal?: AbortSignal;
}

/** What `box.run()` resolves to. */
export interface BoxRun {
	/** The Box as last read, after it became ready. */
	box: Box;
	/** The command's exit code and captured output. */
	result: BoxExecResult;
}

const DEFAULT_POLL_INTERVAL_MS = 1000;
const DEFAULT_READY_TIMEOUT_MS = 30 * 60 * 1000;
const USABLE_STATUSES: ReadonlySet<Box["status"]> = new Set([
	"ready",
	"running",
]);

/** Characters the Box service's command-line parser treats as syntax. */
const COMMAND_LINE_SYNTAX = /[\s"'\\]/u;

/**
 * Quotes `word` so the Box service's command-line parser (shell-like
 * splitting in apps/box `parseCommandLine`) reads it back as one word.
 * Single quotes keep everything literal; a single quote inside is closed,
 * escaped and reopened.
 */
export function quoteCommandWord(word: string): string {
	if (!COMMAND_LINE_SYNTAX.test(word)) {
		return word;
	}
	return `'${word.replaceAll("'", "'\\''")}'`;
}

/**
 * Splits `command` into the `{ command, args }` the Box service takes. A
 * string is sent as is (the service splits it); an array's executable is
 * quoted so it reaches the service as one word, and its arguments go in
 * `args`, which the service never splits.
 */
export function commandParts(
	command: string | readonly string[],
	args: readonly string[] | undefined
): { args: string[]; command: string } {
	if (typeof command === "string") {
		if (command.trim() === "") {
			throw invalidInput("box.run(): `command` must not be empty.");
		}
		return { command, args: args === undefined ? [] : [...args] };
	}
	const [executable, ...rest] = command;
	if (executable === undefined || executable.trim() === "") {
		throw invalidInput(
			"box.run(): `command` must name an executable as its first element."
		);
	}
	if (args !== undefined && args.length > 0) {
		throw invalidInput(
			"box.run(): pass the arguments either in the `command` array or in `args`, not both."
		);
	}
	return { command: quoteCommandWord(executable), args: rest };
}

function invalidInput(message: string): RyuConfigurationError {
	return new RyuConfigurationError({
		service: "box",
		status: 0,
		code: "invalid_input",
		message,
	});
}

function abortError(boxId: string | null): RyuAbortError {
	return new RyuAbortError({
		service: "box",
		status: 0,
		message: "Ryu Box: box.run() was aborted by the caller.",
		details: boxId === null ? null : { boxId },
	});
}

/** Waits `ms`, rejecting early with RyuAbortError when `signal` fires. */
function pause(
	ms: number,
	signal: AbortSignal | undefined,
	boxId: string
): Promise<void> {
	if (signal?.aborted) {
		return Promise.reject(abortError(boxId));
	}
	return new Promise((resolve, reject) => {
		const onAbort = () => {
			clearTimeout(timer);
			reject(abortError(boxId));
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/** Test seams and the call's own state for {@link waitForBox} and {@link runBox}. */
export interface BoxRunDeps {
	now?: () => number;
}

/**
 * Polls the Box until it is `ready` or `running`. Raises `box_failed` when it
 * ends in another status and `box_ready_timeout` when `timeoutMs` elapses.
 */
export async function waitForBox(
	client: BoxAPI,
	initial: Box,
	options: {
		pollIntervalMs: number;
		signal: AbortSignal | undefined;
		timeoutMs: number;
	},
	deps: BoxRunDeps = {}
): Promise<Box> {
	const now = deps.now ?? Date.now;
	const deadline = now() + options.timeoutMs;
	let box = initial;
	while (true) {
		if (USABLE_STATUSES.has(box.status)) {
			return box;
		}
		if (box.status !== "provisioning") {
			throw new RyuError({
				service: "box",
				status: 0,
				code: BOX_RUN_CODES.failed,
				message: `Ryu Box: Box ${box.id} is ${box.status}${
					box.lastError ? `: ${box.lastError}` : ""
				}.`,
				details: {
					boxId: box.id,
					lastError: box.lastError,
					status: box.status,
				},
				retryable: false,
			});
		}
		if (now() >= deadline) {
			throw new RyuTimeoutError({
				service: "box",
				status: 0,
				code: BOX_RUN_CODES.readyTimeout,
				message: `Ryu Box: Box ${box.id} is still provisioning after ${options.timeoutMs} ms.`,
				details: { boxId: box.id },
				retryable: false,
			});
		}
		await pause(options.pollIntervalMs, options.signal, box.id);
		box = await client.get(box.id);
	}
}

/** A fetch that adds `signal` to every request that has none. */
export function withSignal(
	fetch: RyuFetch,
	signal: AbortSignal | undefined
): RyuFetch {
	if (signal === undefined) {
		return fetch;
	}
	return (input, init) =>
		fetch(input, { ...init, signal: init?.signal ?? signal });
}

/**
 * Drains a streamed command into the result the plain route would return:
 * the output in order, the exit code (`-1` when the command was killed or
 * timed out without one) and the duration. A stream that ends before its
 * `exit` event is a RyuConnectionError; the service stops a command whose
 * stream closes, so the command is not left running.
 */
export async function collectExec(
	events: AsyncIterable<BoxStreamEvent>,
	boxId: string
): Promise<BoxExecResult> {
	let stdout = "";
	let stderr = "";
	for await (const event of events) {
		if (event.type === "stdout") {
			stdout += event.data;
		} else if (event.type === "stderr") {
			stderr += event.data;
		} else if (event.type === "exit") {
			return {
				durationMs: event.durationMs ?? 0,
				exitCode: event.exitCode ?? -1,
				stderr,
				stdout,
			};
		}
	}
	throw new RyuConnectionError({
		service: "box",
		status: 0,
		message: `Ryu Box: the command stream in Box ${boxId} ended before the command finished.`,
		details: { boxId },
	});
}

/** Lower-case hex SHA-256 of `text`. */
async function sha256Hex(text: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(text)
	);
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0")
	).join("");
}

/**
 * The Box name `box.run()` uses when the caller gives none. With a key it is
 * derived from the key, so a retried run sends the same create body and the
 * service replays the first Box instead of answering `idempotency_conflict`.
 */
export async function defaultRunName(
	idempotencyKey: string | undefined
): Promise<string> {
	if (idempotencyKey === undefined) {
		return `run-${newIdempotencyKey().slice(0, 8)}`;
	}
	return `run-${(await sha256Hex(idempotencyKey)).slice(0, 12)}`;
}

/**
 * `box.run()`. `client(signal)` builds the Box client for this run on the
 * call's fetch, with `signal` (the run's own) added to every request.
 */
export async function runBox(
	input: BoxRunInput,
	options: BoxRunOptions,
	client: (signal: AbortSignal | undefined) => BoxAPI,
	call: { idempotencyKey?: string; signal?: AbortSignal },
	deps: BoxRunDeps = {}
): Promise<BoxRun> {
	const { command, args, cwd, stdin, timeoutSecs, user, name, ...create } =
		input;
	const parts = commandParts(command, args);
	const signal = options.signal ?? call.signal;
	if (signal?.aborted) {
		throw abortError(null);
	}
	const api = client(options.signal);
	const createInput: CreateBoxInput = {
		...create,
		name:
			name ??
			(await defaultRunName(options.idempotencyKey ?? call.idempotencyKey)),
	};
	const created =
		options.idempotencyKey === undefined
			? await api.create(createInput)
			: await api.create(createInput, options.idempotencyKey);
	const box = await waitForBox(
		api,
		created,
		{
			pollIntervalMs: options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
			signal,
			timeoutMs: options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
		},
		deps
	);
	const commandInput: BoxCommandInput = { ...parts };
	if (cwd !== undefined) {
		commandInput.cwd = cwd;
	}
	if (stdin !== undefined) {
		commandInput.stdin = stdin;
	}
	if (timeoutSecs !== undefined) {
		commandInput.timeoutSecs = timeoutSecs;
	}
	if (user !== undefined) {
		commandInput.user = user;
	}
	const result = await collectExec(
		api.execStream(box.id, commandInput),
		box.id
	);
	return { box, result };
}
