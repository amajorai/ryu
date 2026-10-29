// packages/services-cli/src/commands/box.ts
//
// `ryu-services box …`: Ryu Box commands.
//
//   list
//   create [--name N] [--size small|default|large] [--image I] [--setup CMD]… [--wait]
//   get <id>
//   exec <id> [--cwd D] [--user box|root] [--command-timeout S] [--buffered] -- <cmd…>
//   stop <id> | resume <id> | delete <id>
//
// Configuration comes from RYU_BOX_URL and RYU_BOX_API_KEY, or --base-url /
// --api-key. `ctx.ryu` already carries --idempotency-key (used by `create`)
// and --timeout.
//
// `create` without --name derives the name from --idempotency-key when one
// is given, so rerunning the same command replays the first Box (200)
// instead of answering `idempotency_conflict`.
//
// `exec` sends the words after `--` verbatim: the executable is quoted for
// the service's shell-like splitting and the rest go in `args`. It streams
// the command's output as it arrives: raw to stdout and
// stderr, or one JSON line per event with --json. It is not retried, so a
// command never runs twice because of the CLI. When the remote command
// exits non-zero (or is killed or times out), `exec` fails with the RyuError
// `command_failed` and exits 1, so `box exec … && deploy` stops; the output
// is printed first. `--buffered` waits on the plain route with a request
// timeout that covers --command-timeout (service default 120 s) unless
// --timeout is given.

import { RyuConnectionError, RyuError, toResult } from "@ryuhq/services";
import {
	booleanFlag,
	CliUsageError,
	countFlag,
	stringFlag,
	stringsFlag,
} from "../args.ts";
import { listPage } from "../list-output.ts";
import { printSuccess } from "../output.ts";
import type { CommandContext, ServiceCommand } from "../registry.ts";
import { type SettledCall, settledWith } from "../settled.ts";

type BoxSize = "small" | "default" | "large";
type BoxUser = "box" | "root";

const SIZES: readonly BoxSize[] = ["small", "default", "large"];

function requireId(ctx: CommandContext): string {
	const [value, ...extra] = ctx.args;
	if (value === undefined || value === "") {
		throw new CliUsageError("<id> is required.");
	}
	if (extra.length > 0) {
		throw new CliUsageError(
			`Unexpected arguments: ${extra.map((item) => JSON.stringify(item)).join(" ")}. Put the command after --.`
		);
	}
	return value;
}

function rejectArgs(ctx: CommandContext): void {
	if (ctx.args.length > 0 || ctx.rest.length > 0) {
		throw new CliUsageError(
			`Unexpected arguments: ${[...ctx.args, ...ctx.rest].map((item) => JSON.stringify(item)).join(" ")}.`
		);
	}
}

function sizeFlag(ctx: CommandContext): BoxSize | undefined {
	const value = stringFlag(ctx.flags, "size");
	if (value === undefined) {
		return;
	}
	if (!SIZES.includes(value as BoxSize)) {
		throw new CliUsageError(`--size must be one of ${SIZES.join(", ")}.`);
	}
	return value as BoxSize;
}

function userFlag(ctx: CommandContext): BoxUser | undefined {
	const value = stringFlag(ctx.flags, "user");
	if (value === undefined) {
		return;
	}
	if (value !== "box" && value !== "root") {
		throw new CliUsageError('--user must be "box" or "root".');
	}
	return value;
}

/** The service's default command timeout, in seconds (apps/box contracts). */
const DEFAULT_COMMAND_TIMEOUT_SECS = 120;
/** Extra request time beyond the command's own timeout, for queueing and the reply. */
const BUFFERED_TIMEOUT_MARGIN_MS = 30_000;

const FNV_OFFSET = 0xcb_f2_9c_e4_84_22_23_25n;
const FNV_PRIME = 0x1_00_00_00_01_b3n;
const UINT64 = 0xff_ff_ff_ff_ff_ff_ff_ffn;

/** FNV-1a 64-bit of `text` as 16 hex digits: a stable, synchronous name seed (not a secret). */
function fnv1a64(text: string): string {
	let hash = FNV_OFFSET;
	for (const byte of new TextEncoder().encode(text)) {
		hash = ((hash ^ BigInt(byte)) * FNV_PRIME) & UINT64;
	}
	return hash.toString(16).padStart(16, "0");
}

/**
 * The default Box name: derived from the idempotency key when one is given,
 * so a rerun sends the same body and replays the first create; random
 * otherwise. Synchronous, so `create` still returns the facade promise and
 * `--json` keeps the response meta.
 */
function cliBoxName(idempotencyKey: string | undefined): string {
	if (idempotencyKey === undefined) {
		return `cli-${crypto.randomUUID().slice(0, 8)}`;
	}
	return `cli-${fnv1a64(idempotencyKey).slice(0, 12)}`;
}

/** Characters the Box service's command-line parser treats as syntax. */
const COMMAND_LINE_SYNTAX = /[\s"'\\]/u;

/**
 * Quotes the executable so the service, which splits `command` like a shell
 * would, reads it back as the one word the user typed after `--`.
 */
function quoteCommandWord(word: string): string {
	return COMMAND_LINE_SYNTAX.test(word)
		? `'${word.replaceAll("'", "'\\''")}'`
		: word;
}

/** The RyuError `exec` fails with when the remote command did not exit 0. */
function commandFailed(
	exitCode: unknown,
	status: unknown,
	details: Record<string, unknown>
): RyuError {
	return new RyuError({
		service: "box",
		status: 0,
		code: "command_failed",
		message: `box exec: the command ${String(status)} with exit code ${String(exitCode)}.`,
		details,
		retryable: false,
	});
}

const listBoxes: ServiceCommand = {
	path: ["list"],
	summary: "List the tenant's Boxes, one JSON line each.",
	readOnly: true,
	run: (ctx) => {
		rejectArgs(ctx);
		return listPage(ctx, ctx.ryu.box.list(), {
			noun: "Boxes",
			items: (boxes) => boxes,
		});
	},
};

/**
 * `create --wait`: the ready Box, printed with the create call's meta (its
 * request id, status, idempotency key and replay flag), not the last poll's.
 */
async function createAndWait(
	ctx: CommandContext,
	input: Parameters<CommandContext["ryu"]["box"]["create"]>[0]
): Promise<SettledCall> {
	const box = ctx.ryu.box;
	const created = await toResult(box.create(input));
	if (created.error !== null) {
		throw created.error;
	}
	const ready =
		created.data.status === "provisioning"
			? await box.waitUntilReady(created.data.id)
			: created.data;
	return settledWith(ready, created.meta);
}

const createBox: ServiceCommand = {
	path: ["create"],
	summary:
		"Create a Box (one Idempotency-Key for all retries; --idempotency-key to choose it).",
	example: "ryu-services box create --wait --idempotency-key first-box",
	flags: {
		name: {
			type: "string",
			valueName: "name",
			description:
				"Box name (default cli-<hex>, derived from --idempotency-key when given so a rerun replays the same Box).",
		},
		size: {
			type: "string",
			valueName: "small|default|large",
			description: "Machine size (default: the service's default).",
		},
		image: {
			type: "string",
			valueName: "image",
			description: "Container image to boot.",
		},
		setup: {
			type: "strings",
			valueName: "cmd",
			description:
				"A shell command run as root before the Box is ready; repeat for more.",
		},
		wait: {
			type: "boolean",
			description: "Wait until the Box leaves provisioning before printing it.",
		},
	},
	run: (ctx) => {
		rejectArgs(ctx);
		const size = sizeFlag(ctx);
		const image = stringFlag(ctx.flags, "image");
		const setup = stringsFlag(ctx.flags, "setup");
		const input = {
			name:
				stringFlag(ctx.flags, "name") ?? cliBoxName(ctx.call.idempotencyKey),
			...(size === undefined ? {} : { size }),
			...(image === undefined ? {} : { image }),
			...(setup.length === 0 ? {} : { setup: [...setup] }),
		};
		return booleanFlag(ctx.flags, "wait")
			? createAndWait(ctx, input)
			: ctx.ryu.box.create(input);
	},
};

const getBox: ServiceCommand = {
	path: ["get"],
	usage: "<id>",
	summary: "Show a Box.",
	readOnly: true,
	run: (ctx) => ctx.ryu.box.get(requireId(ctx)),
};

type StreamEvent = { type: string } & Record<string, unknown>;

/**
 * Passes every event through, then fails with `command_failed` when the
 * `exit` event carried a non-zero (or no) exit code, so the CLI exits 1
 * after the whole output was printed. A stream that ends without any `exit`
 * event fails with a connection error, as the SDK's `box.run()` does: the
 * command never reported finishing, so `box exec … && deploy` must stop.
 */
async function* failOnNonZeroExit(
	events: AsyncIterable<StreamEvent>
): AsyncGenerator<StreamEvent> {
	let failure: RyuError | null = null;
	let sawExit = false;
	for await (const event of events) {
		if (event.type === "exit") {
			sawExit = true;
		}
		if (event.type === "exit" && event.exitCode !== 0) {
			failure = commandFailed(event.exitCode, event.status, {
				exitCode: event.exitCode ?? null,
				status: event.status ?? null,
			});
		}
		yield event;
	}
	if (failure !== null) {
		throw failure;
	}
	if (!sawExit) {
		throw new RyuConnectionError({
			service: "box",
			status: 0,
			message:
				"box exec: the command stream ended before the command finished.",
		});
	}
}

/** Writes each streamed event raw: stdout and stderr output as it arrives. */
async function writeRaw(
	ctx: CommandContext,
	events: AsyncIterable<StreamEvent>
): Promise<void> {
	for await (const event of failOnNonZeroExit(events)) {
		if (event.type === "stdout" && typeof event.data === "string") {
			ctx.io.stdout.write(event.data);
		} else if (event.type === "stderr" && typeof event.data === "string") {
			ctx.io.stderr.write(event.data);
		}
	}
}

/**
 * `exec --buffered`: the plain route, which answers only once the command
 * has ended, under a request timeout that covers the command's own (unless
 * --timeout was given). A non-zero exit prints the result, then fails.
 */
async function execBuffered(
	ctx: CommandContext,
	boxId: string,
	input: Parameters<CommandContext["ryu"]["box"]["exec"]>[1]
) {
	const timeoutMs =
		ctx.call.timeoutMs ??
		(input.timeoutSecs ?? DEFAULT_COMMAND_TIMEOUT_SECS) * 1000 +
			BUFFERED_TIMEOUT_MARGIN_MS;
	const result = await ctx.ryu.box.with({ timeoutMs }).exec(boxId, input);
	if (result.exitCode === 0) {
		return result;
	}
	if (!ctx.json) {
		printSuccess(ctx.io.stdout, false, result, null);
	}
	throw commandFailed(result.exitCode, "exited", { ...result });
}

/**
 * The human-mode result of `exec`: an iterable with no items whose first
 * step drains the stream through {@link writeRaw}, so the CLI streams the
 * output as it arrives and prints nothing after it (and `--dry-run` still
 * captures the request on that first step).
 */
function rawOutput(
	ctx: CommandContext,
	events: AsyncIterable<StreamEvent>
): AsyncIterable<never> {
	return {
		[Symbol.asyncIterator]: () => ({
			next: async (): Promise<IteratorResult<never, undefined>> => {
				await writeRaw(ctx, events);
				return { done: true, value: undefined };
			},
		}),
	};
}

const execCommand: ServiceCommand = {
	path: ["exec"],
	usage: "<id> -- <cmd…>",
	summary:
		"Run a command in a Box and stream its output (never retried; exits 1 when the command exits non-zero).",
	example: "ryu-services box exec <id> -- ls -la",
	flags: {
		cwd: {
			type: "string",
			valueName: "dir",
			description: "Working directory, relative to /workspace.",
		},
		user: {
			type: "string",
			valueName: "box|root",
			description: 'Run as "box" (default) or "root".',
		},
		"command-timeout": {
			type: "number",
			valueName: "seconds",
			description: "Kill the command after this long (service default 120).",
		},
		buffered: {
			type: "boolean",
			description:
				"Wait for the command and print { exitCode, stdout, stderr, durationMs } instead of streaming.",
		},
	},
	run: (ctx) => {
		const boxId = requireId(ctx);
		const [command, ...args] = ctx.rest;
		if (command === undefined || command === "") {
			throw new CliUsageError(
				"Give the command after --, e.g. ryu-services box exec <id> -- ls -la."
			);
		}
		const cwd = stringFlag(ctx.flags, "cwd");
		const user = userFlag(ctx);
		const timeoutSecs = countFlag(ctx.flags, "command-timeout");
		const input = {
			command: quoteCommandWord(command),
			args,
			...(cwd === undefined ? {} : { cwd }),
			...(user === undefined ? {} : { user }),
			...(timeoutSecs === undefined ? {} : { timeoutSecs }),
		};
		if (booleanFlag(ctx.flags, "buffered")) {
			return execBuffered(ctx, boxId, input);
		}
		const events = ctx.ryu.box.execStream(boxId, input);
		return ctx.json ? failOnNonZeroExit(events) : rawOutput(ctx, events);
	},
};

/**
 * How long `box stop` waits for its re-read, retries included. The stop has
 * already succeeded, so a slow or failing GET must not hold the command up.
 */
export const STOP_REREAD_DEADLINE_MS = 5000;

/**
 * `box stop` prints the Box as re-read after the stop (the stop route answers
 * without one), so a script reads its status the way it does after `resume`.
 * The output carries the stop's meta (its request id and Idempotency-Key),
 * not the GET's. The stop already succeeded, so a failed or slow re-read
 * (bounded by `deadlineMs`, retries included) prints OK, or `data: null`
 * with the stop's meta under `--json`, rather than failing the command.
 */
export async function stopAndReread(
	box: Pick<CommandContext["ryu"]["box"], "stop" | "with">,
	boxId: string,
	deadlineMs: number = STOP_REREAD_DEADLINE_MS
): Promise<SettledCall> {
	const stopped = await toResult(box.stop(boxId));
	if (stopped.error !== null) {
		throw stopped.error;
	}
	try {
		const current = await box
			.with({ signal: AbortSignal.timeout(deadlineMs) })
			.get(boxId);
		return settledWith(current, stopped.meta);
	} catch {
		return settledWith(undefined, stopped.meta);
	}
}

function lifecycle(
	name: "stop" | "resume" | "delete",
	summary: string
): ServiceCommand {
	return {
		path: [name],
		usage: "<id>",
		summary,
		run: (ctx) => {
			const boxId = requireId(ctx);
			switch (name) {
				case "stop":
					return stopAndReread(ctx.ryu.box, boxId);
				case "resume":
					return ctx.ryu.box.resume(boxId);
				default:
					return ctx.ryu.box.delete(boxId);
			}
		},
	};
}

/** Every `ryu-services box` command. */
export const boxCommands: readonly ServiceCommand[] = [
	listBoxes,
	createBox,
	getBox,
	execCommand,
	lifecycle(
		"stop",
		"Stop a Box; its disk is kept and compute metering pauses. Prints the Box as read after the stop."
	),
	lifecycle("resume", "Resume a stopped Box."),
	lifecycle("delete", "Delete a Box and its disk. Not reversible. Prints OK."),
];
