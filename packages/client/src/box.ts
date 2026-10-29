import { SseFrameDecoder } from "@ryuhq/protocol/sse";
import { z } from "zod";
import {
	boxDesktopTokenSchema,
	boxEventSchema,
	boxExitSchema,
	boxFileSchema,
	boxLimitsSchema,
	boxLogsSchema,
	boxPreviewSchema,
	boxProcessSchema,
	boxPromptSchema,
	boxResultSchema,
	boxSchema,
	boxSecretSchema,
	boxSnapshotSchema,
	boxSshSchema,
	boxTokenSchema,
	boxUsageSchema,
} from "./box-contracts.ts";
import { assertSafeRequestPath, encodePathId } from "./path-id.ts";
import { wireJsonRecordSchema, wireJsonSchema } from "./wire-json.ts";
// packages/client/src/box.ts
//
// Client for the standalone Ryu Box service (`apps/box`): Boxes, commands,
// background processes, files, previews, terminals, tunnels, SSH, snapshots,
// secrets and usage. It talks to the service directly with a tenant API key.

import type { RyuFetch } from "./types.ts";

export type BoxSize = "small" | "default" | "large";
export type BoxNetwork = "none" | "egress" | "allowlist";
export type BoxUser = "box" | "root";
export type BoxStatus =
	| "provisioning"
	| "ready"
	| "running"
	| "stopping"
	| "stopped"
	| "error"
	| "deleted";
export type BoxAgentProvider =
	| "codex"
	| "cursor"
	| "claude"
	| "claude-code"
	| "opencode";

export interface BoxClientOptions {
	/** Tenant API key the Box service was configured with. */
	apiKey: string;
	/** Base URL of the Box service, for example `https://box.example.com`. */
	baseUrl: string;
	fetch?: RyuFetch;
	/** WebSocket constructor; defaults to `globalThis.WebSocket`. */
	webSocket?: typeof WebSocket;
}

/** Where a Box runs while it is placed. */
export interface BoxPlacement {
	isolation: "container" | "gvisor" | "host" | "microvm" | "vm";
	location: string;
	provider: "hetzner" | "vultr" | "digitalocean" | "overflow" | "local";
	serverType: string;
	tier: "parked" | "hetzner" | "pool" | "overflow" | "fallback" | "local";
}

/** A Box's own virtual desktop, present when it was created with `desktop: true`. */
export interface BoxDesktop {
	height: number;
	ready: boolean;
	viewers: number;
	width: number;
}

export interface Box {
	/** Hosts reachable with the `allowlist` network. */
	allowedHosts: string[];
	/**
	 * How the current running interval is billed; absent while not running.
	 * `minimumWaived` is true for a resume onto the Box's own parked VM inside
	 * the provider hour already paid for (until `paidHourEndsAt`): it owes no
	 * new five-minute minimum, only whole minutes. `waiver` is that verdict
	 * signed for the Gateway, on a Core-tenant Box only.
	 */
	billing?: {
		minimumWaived: boolean;
		paidHourEndsAt: string | null;
		waiver?: string;
	};
	/** When the Box was created. */
	createdAt: string;
	/** The Box's own virtual desktop and browser, when one was started. */
	desktop?: BoxDesktop;
	/** The driver that runs the Box, such as `docker`. */
	driver: string;
	/**
	 * Names of the environment variables set at creation; values are never
	 * returned.
	 */
	envNames: string[];
	/** The Box id (`bx_<32 hex>`). */
	id: string;
	/** The container image the Box booted from. */
	image: string;
	/**
	 * Why the Box last failed or needs attention, for a person; null when nothing
	 * is wrong.
	 */
	lastError: string | null;
	/** The name given at creation. */
	name: string;
	/**
	 * `none`: no outbound network. `egress`: any outbound host. `allowlist`: only
	 * `allowedHosts`.
	 */
	network: BoxNetwork;
	/** Where the Box runs, when the service reports it. */
	placement?: BoxPlacement;
	/** The repository cloned at creation, without credentials, or null. */
	repo: { branch: string | null; url: string } | null;
	/** When the current running interval began; null while not running. */
	runningSince?: string | null;
	/** Names of the tenant secrets exposed to every command. */
	secrets: string[];
	/**
	 * `small`, `default` or `large`; a larger size has more vCPU and memory and
	 * counts for more resource units.
	 */
	size: BoxSize;
	/** The snapshot the Box booted from, or null. */
	snapshotId: string | null;
	/**
	 * `provisioning` while the machine is created and set up, `ready` once
	 * commands can run, `running` while a foreground command runs, `stopped`
	 * after a stop (resume it to run again), `error` when provisioning or a
	 * resume failed (see `lastError`), `deleted` once removed.
	 */
	status: BoxStatus;
	/** When the Box was last stopped; null while it is not stopped. */
	stoppedAt: string | null;
	/** Lifetime from creation before the Box expires; null for none. */
	ttlSeconds: number | null;
	/** When the Box last changed. */
	updatedAt: string;
}

export interface CreateBoxInput {
	/** Hosts reachable with `allowlist`; `*.example.com` matches subdomains. */
	allowedHosts?: string[];
	/** Start the Box's own virtual desktop and browser. */
	desktop?: boolean;
	/**
	 * Environment variables for every command. Reads return only their names
	 * (`envNames`).
	 */
	env?: Record<string, string>;
	/** Container image. The operator may restrict which images are allowed. */
	image?: string;
	/** Up to 8 labels; keys are 1-32 of `a-z`, `0-9` and `-`, values at most 64 characters. */
	labels?: Record<string, string>;
	/** Box name. */
	name: string;
	/** Default `none`, or `allowlist` when `allowedHosts` is set. */
	network?: BoxNetwork;
	/** A repository to clone; needs egress or an allowlist. */
	repo?: { branch?: string; tokenSecret?: string; url: string };
	/**
	 * Tenant secrets exposed to every command by name.
	 *
	 * Each is exposed as an environment variable.
	 */
	secrets?: string[];
	/** Shell commands run as root, in order, before `ready`. */
	setup?: string[];
	/**
	 * `small` (2 vCPU, 4 GiB), `default` (4 vCPU, 8 GiB) or `large` (8 vCPU, 16
	 * GiB). `type` is accepted as an alias.
	 */
	size?: BoxSize;
	/** Snapshot id or name to boot from instead of `image`. */
	snapshot?: string;
	/** Lifetime before the Box expires. Default one day. */
	ttlSeconds?: number;
}

export interface BoxCommandInput {
	/** Arguments passed as they are, after any in `command`. */
	args?: string[];
	/**
	 * The executable, optionally followed by arguments (split like a shell would,
	 * without running one).
	 */
	command: string;
	/** Relative to `/workspace`. Default `.`. */
	cwd?: string;
	/** Extra environment variables for this command only. */
	env?: Record<string, string>;
	/** Text written to the command's stdin before it is closed. */
	stdin?: string;
	/** Default 120 (foreground). */
	timeoutSecs?: number;
	/** Run as the unprivileged `box` user or as `root`. */
	user?: BoxUser;
}

export interface BoxExecResult {
	/** How long the command ran, in milliseconds. */
	durationMs: number;
	/** The command's exit code. */
	exitCode: number;
	/** Everything written to stderr (truncated past the output limit). */
	stderr: string;
	/** Everything written to stdout (truncated past the output limit). */
	stdout: string;
}

export type BoxProcessStatus = "exited" | "killed" | "running" | "timed_out";

export interface BoxProcess {
	/** Its arguments. */
	args: string[];
	/** True when it was started with `background` and returned at once. */
	background: boolean;
	/** The Box it runs in. */
	boxId: string;
	/** The executable. */
	command: string;
	/** The working directory. */
	cwd: string;
	/** How long it ran, in milliseconds; null while running. */
	durationMs: number | null;
	/** When it ended; null while running. */
	endedAt: string | null;
	/** The exit code; null while running or when it has none. */
	exitCode: number | null;
	/** The process id (`proc_<32 hex>`). */
	id: string;
	/**
	 * What started it: a `command`, a managed `prompt`, a creation `setup` step,
	 * an `ssh` session or a `terminal`.
	 */
	kind: "command" | "prompt" | "setup" | "ssh" | "terminal";
	/**
	 * True when the output passed the retained limit and older output was
	 * dropped.
	 */
	outputTruncated: boolean;
	/** When it started. */
	startedAt: string;
	/**
	 * `running`, then `exited` (see `exitCode`), `killed` (interrupted) or
	 * `timed_out`.
	 */
	status: BoxProcessStatus;
}

export interface BoxOutputChunk {
	/** The text written. */
	data: string;
	/**
	 * Position in the process's output, starting at 1; pass the last one seen to
	 * resume after it.
	 */
	seq: number;
	/** Which stream wrote it. */
	stream: "stderr" | "stdout";
}

/** One item of a streamed command or followed process log. */
export type BoxStreamEvent =
	| { process: BoxProcess; type: "process" }
	| { data: string; seq: number; type: "stderr" | "stdout" }
	| {
			durationMs?: number | null;
			exitCode: number | null;
			status: BoxProcessStatus;
			type: "exit";
	  };

export interface BoxFileEntry {
	/** Its permission bits in octal, such as `644`. */
	mode: string;
	/** When it was last modified. */
	modifiedAt: string;
	/** The entry's file name. */
	name: string;
	/** Its path: the listed directory joined with `name`. */
	path: string;
	/** Its size in bytes. */
	size: number;
	/** Whether it is a file, a directory, a symlink or something else. */
	type: "directory" | "file" | "other" | "symlink";
}

export interface BoxPreview {
	/** When the preview was created. */
	createdAt: string;
	/** The port inside the Box the preview forwards to. */
	port: number;
	/** The preview's token; it is part of the preview URL's host. */
	token: string;
	/** The URL that reaches the port. */
	url: string;
	/** `public`: anyone with the URL. `private`: requests need the tenant key. */
	visibility: "private" | "public";
}

export interface BoxAccessToken {
	/** When the token stops working. */
	expiresAt: string;
	/** The short-lived token. */
	token: string;
	/** The WebSocket URL that carries the token. */
	url: string;
}

/** Scopes of a short-lived Box access token. */
export type BoxAccessScope = "terminal" | "tunnel" | "desktop";

/** Request for a single-use desktop stream token. */
export interface BoxDesktopTokenInput {
	/** The browser origin that will open the stream; the service checks it on upgrade. */
	origin: string;
	scope: "desktop";
	/** The viewer the token is for. */
	sub: string;
	/** Watch only: input from this viewer is dropped. */
	viewOnly?: boolean;
}

/**
 * A single-use, 30-second desktop stream token. Dial `url` with `protocols` as
 * the WebSocket subprotocols; the token travels in `protocols`, never in the URL.
 */
export interface BoxDesktopAccessToken {
	expiresAt: string;
	protocols: string[];
	token: string;
	/** Absolute WebSocket URL of the Box's desktop stream. */
	url: string;
}

/** `GET /v1/limits`: the tenant's usage against its admission limits. */
export interface BoxLimits {
	maxResourceUnits: number;
	maxRunning: number;
	maxStored: number;
	resourceUnits: number;
	running: number;
	stored: number;
}

export interface BoxSsh {
	host: string;
	port: number;
	/** `ProxyCommand` for ~/.ssh/config; reads RYU_BOX_URL and RYU_BOX_API_KEY. */
	proxyCommand: string;
	tunnelUrl: string;
	user: string;
}

export interface BoxSnapshot {
	/** The Box it was taken from. */
	boxId: string;
	/** When it was taken. */
	createdAt: string;
	/** The snapshot id. */
	id: string;
	/** Its name; pass it (or `id`) as `snapshot` when creating a Box. */
	name: string;
	/** The source Box's network mode. */
	network: BoxNetwork;
	/** The source Box's size. */
	size: BoxSize;
}

export interface BoxEvent {
	/** When it happened. */
	createdAt: string;
	/** The event's sequence number. */
	id: number;
	/** Facts about the event; the members depend on `type`. */
	payload: z.infer<typeof wireJsonRecordSchema>;
	/** What happened, such as `box.created` or `box.stopped`. */
	type: string;
}

/** Why the Box failed a prompt run the agent did not finish itself. */
export type BoxPromptFailureReason =
	| "box_destroyed"
	| "canceled"
	| "service_restarted"
	| "timeout";

export interface BoxPromptRun {
	/** When it finished; null until then. */
	completedAt: string | null;
	/** When it was queued. */
	createdAt: string;
	/**
	 * `managed`: Box runs the provider's CLI. `worker`: an external worker claims
	 * and completes it.
	 */
	execution: "managed" | "worker";
	/** The agent's exit code; null until it finishes. */
	exitCode: number | null;
	/** The prompt run id. */
	id: string;
	/** The managed run's process; null for a worker run or before it starts. */
	processId: string | null;
	/** The coding agent CLI that runs it. */
	provider: BoxAgentProvider;
	/**
	 * Why a run failed without finishing itself: its Box was destroyed, it was
	 * canceled, the service restarted, or it timed out; null otherwise.
	 */
	reason: BoxPromptFailureReason | null;
	/** `queued`, then `running`, then `completed` or `failed`. */
	status: string;
	/**
	 * What the run did, for a person; null when none was reported.
	 *
	 * The tail of the agent's output, at most 4000 characters.
	 */
	summary: string | null;
}

/** Input for `prompt()`; `cwd`, `env`, and `timeoutSeconds` apply to managed runs only. */
export interface BoxPromptInput {
	/**
	 * Managed only.
	 *
	 * Working directory relative to `/workspace`; defaults to the repo directory.
	 */
	cwd?: string;
	/**
	 * Managed only; never stored.
	 *
	 * Agent process env, held in memory for the run.
	 */
	env?: Record<string, string>;
	/**
	 * `managed`: Box runs the provider's CLI. `worker`: an external worker claims
	 * and completes the run.
	 */
	execution?: "managed" | "worker";
	/** The coding agent CLI that runs the prompt. */
	provider: BoxAgentProvider;
	/** The prompt. */
	text: string;
	/**
	 * Managed only.
	 *
	 * Hard limit on the agent process, 60 to 14400 seconds.
	 */
	timeoutSeconds?: number;
}

export interface BoxUsageLine {
	/**
	 * Billable running seconds: each running interval rounded up to whole
	 * minutes with a five-minute minimum per start or resume, counted in the
	 * window where the interval started. Compute is charged on this at the
	 * size's hourly rate. Sent by Box services that bill per size.
	 */
	billableSeconds?: number;
	boxId: string;
	/** Running seconds weighted by the size's resource units. */
	resourceUnitSeconds: number;
	/** Seconds the Box ran inside the window; stopped time is not counted. */
	seconds: number;
	/** The Box's size; sent by Box services that report storage. */
	size?: BoxSize;
	/**
	 * Byte-seconds of the Box's saved state stored inside the window (its
	 * newest saved state's bytes for as long as it was kept). Storage is
	 * charged on this above the organization's included storage. Sent by Box
	 * services that keep saved state outside the Box.
	 */
	stateByteSeconds?: number;
	/** The newest saved state's size in bytes; 0 when none is kept. */
	stateBytes?: number;
	/**
	 * The size's disk allowance in GiB. Reported for compatibility; it is no
	 * longer what storage is charged on.
	 * @deprecated Storage is charged on `stateByteSeconds` and snapshot sizes.
	 */
	storageAllowanceGib?: number;
	/**
	 * Seconds the Box existed inside the window, from creation to deletion or
	 * expiry, running or stopped.
	 */
	storageSeconds?: number;
}

export interface BoxSnapshotUsageLine {
	/** The snapshot image's size, measured when it was committed. */
	sizeBytes: number;
	snapshotId: string;
	/** Seconds the snapshot existed inside the window, up to its deletion. */
	storageSeconds: number;
}

export interface BoxUsage {
	/**
	 * One line per Box that existed in the window, stopped ones included:
	 * `seconds` it ran, `resourceUnitSeconds` (running seconds weighted by size),
	 * its `storageAllowanceGib`, and `storageSeconds` it existed.
	 */
	boxes: BoxUsageLine[];
	/** Start of the reported window. */
	from: string;
	/**
	 * Snapshots that existed in the window, with their measured `sizeBytes` and
	 * `storageSeconds` existed.
	 *
	 * Sent by Box services that report snapshot storage. A fork's private image is not listed.
	 */
	snapshots?: BoxSnapshotUsageLine[];
	/** End of the reported window. */
	to: string;
	/** Running `seconds` and `resourceUnitSeconds` summed over `boxes`. */
	totals: {
		/** The sum of the lines' `billableSeconds`, when they are sent. */
		billableSeconds?: number;
		resourceUnitSeconds: number;
		seconds: number;
	};
}

interface BoxControlRequest {
	close?: boolean;
	cwd?: string;
	data?: string;
	env?: Record<string, string>;
	execution?: "managed" | "worker";
	name?: string;
	origin?: string;
	path?: string;
	port?: number;
	provider?: BoxAgentProvider;
	publicKey?: string;
	scope?: BoxAccessScope;
	size?: BoxSize;
	sub?: string;
	text?: string;
	timeoutSeconds?: number;
	value?: string;
	viewOnly?: boolean;
	visibility?: "private" | "public";
}
type BoxJsonRequest =
	| CreateBoxInput
	| BoxCommandInput
	| (BoxCommandInput & { background: boolean })
	| BoxControlRequest;
const TRAILING_SLASHES = /\/+$/u;
const HTTP_SCHEME = /^http/u;

/** Parses a Server-Sent Events body into `{ event, id, data }` frames. */
export async function* readServerSentEvents(
	body: ReadableStream<Uint8Array>
): AsyncGenerator<{
	data: z.infer<typeof wireJsonSchema>;
	event: string;
	id: string | null;
}> {
	// Bounded incremental framing: an event that never ends is refused at the
	// frame limit instead of growing this process's memory.
	const reader = body.getReader();
	const decoder = new SseFrameDecoder();
	try {
		while (true) {
			const chunk = await reader.read();
			if (chunk.done) {
				decoder.finish();
				break;
			}
			for (const frame of decoder.push(chunk.value)) {
				let event = "message";
				let id: string | null = null;
				const data: string[] = [];
				for (const line of frame.split("\n")) {
					if (line.startsWith("event:")) {
						event = line.slice(6).trim();
					} else if (line.startsWith("id:")) {
						id = line.slice(3).trim();
					} else if (line.startsWith("data:")) {
						data.push(line.slice(5).trimStart());
					}
				}
				if (data.length > 0) {
					yield {
						data: wireJsonSchema.parse(JSON.parse(data.join("\n"))),
						event,
						id,
					};
				}
			}
		}
	} finally {
		decoder.finish();
		await reader.cancel().catch(() => undefined);
		reader.releaseLock();
	}
}

function toStreamEvent(frame: {
	data: z.infer<typeof wireJsonSchema>;
	event: string;
	id: string | null;
}): BoxStreamEvent | null {
	const data = wireJsonRecordSchema.parse(frame.data);
	if (frame.event === "process") {
		return { process: boxProcessSchema.parse(data), type: "process" };
	}
	if (frame.event === "stdout" || frame.event === "stderr") {
		return {
			data: String(data.data ?? ""),
			seq: Number(frame.id ?? 0),
			type: frame.event,
		};
	}
	if (frame.event === "exit") {
		const exit = boxExitSchema.parse(data);
		return {
			durationMs: exit.durationMs ?? null,
			exitCode: exit.exitCode ?? null,
			status: exit.status,
			type: "exit",
		};
	}
	return null;
}

/** Encodes one path id, refusing `""`, `"."` and `".."` before any request. */
function pathId(value: string): string {
	return encodePathId("Box", value);
}

function query(params: Record<string, string | number | undefined>): string {
	const search = new URLSearchParams();
	for (const [key, value] of Object.entries(params)) {
		if (value !== undefined) {
			search.set(key, String(value));
		}
	}
	const text = search.toString();
	return text ? `?${text}` : "";
}

export class BoxAPI {
	private readonly options: BoxClientOptions;

	constructor(options: BoxClientOptions) {
		this.options = options;
	}

	// --- Boxes -------------------------------------------------------------------

	async list(): Promise<Box[]> {
		return (
			await this.json(
				"GET",
				"/v1/boxes",
				undefined,
				undefined,
				z.object({ boxes: z.array(boxSchema) }).parse
			)
		).boxes;
	}

	/** Creates a Box. It may come back `provisioning` while setup runs; see {@link waitUntilReady}. */
	async create(
		input: CreateBoxInput,
		idempotencyKey: string = newIdempotencyKey()
	): Promise<Box> {
		const response = await this.json(
			"POST",
			"/v1/boxes",
			input,
			{
				"Idempotency-Key": idempotencyKey,
			},
			z.object({ box: boxSchema }).parse
		);
		return response.box;
	}

	async get(boxId: string): Promise<Box> {
		return (
			await this.json(
				"GET",
				this.box(boxId),
				undefined,
				undefined,
				z.object({ box: boxSchema }).parse
			)
		).box;
	}

	/** Polls until the Box leaves `provisioning`; throws if it ends in `error`. */
	async waitUntilReady(
		boxId: string,
		options: { intervalMs?: number; timeoutMs?: number } = {}
	): Promise<Box> {
		const deadline = Date.now() + (options.timeoutMs ?? 30 * 60 * 1000);
		while (true) {
			const box = await this.get(boxId);
			if (box.status === "error") {
				throw new Error(
					`Box ${boxId} failed: ${box.lastError ?? "unknown error"}`
				);
			}
			if (box.status !== "provisioning") {
				return box;
			}
			if (Date.now() > deadline) {
				throw new Error(`Box ${boxId} is still provisioning.`);
			}
			await new Promise((resolve) =>
				setTimeout(resolve, options.intervalMs ?? 1000)
			);
		}
	}

	async delete(boxId: string): Promise<void> {
		await this.json("DELETE", this.box(boxId));
	}

	/** Stops the Box. Running processes end and metering pauses until resume. */
	async stop(boxId: string): Promise<void> {
		await this.json("POST", `${this.box(boxId)}/stop`);
	}

	async resume(boxId: string): Promise<Box> {
		return (
			await this.json(
				"POST",
				`${this.box(boxId)}/resume`,
				undefined,
				undefined,
				z.object({ box: boxSchema }).parse
			)
		).box;
	}

	/** Copies the Box's filesystem into a new Box with the same network policy. */
	async fork(
		boxId: string,
		input: { name?: string; size?: BoxSize } = {},
		idempotencyKey: string = newIdempotencyKey()
	): Promise<Box> {
		const response = await this.json(
			"POST",
			`${this.box(boxId)}/fork`,
			input,
			{ "Idempotency-Key": idempotencyKey },
			z.object({ box: boxSchema }).parse
		);
		return response.box;
	}

	async events(boxId: string, limit?: number): Promise<BoxEvent[]> {
		const response = await this.json(
			"GET",
			`${this.box(boxId)}/events${query({ limit })}`,
			undefined,
			undefined,
			z.object({ events: z.array(boxEventSchema) }).parse
		);
		return response.events;
	}

	/** Follows the Box's event log from `after` until `signal` aborts. */
	async *followEvents(
		boxId: string,
		options: { after?: number; signal?: AbortSignal } = {}
	): AsyncGenerator<BoxEvent> {
		const response = await this.request(
			"GET",
			`${this.box(boxId)}/events${query({ after: options.after, follow: "true" })}`,
			undefined,
			{ Accept: "text/event-stream" },
			options.signal
		);
		for await (const frame of readServerSentEvents(this.body(response))) {
			yield boxEventSchema.parse(frame.data);
		}
	}

	// --- Commands and processes --------------------------------------------------------

	/** Runs a command and waits for it to finish. */
	async exec(boxId: string, input: BoxCommandInput): Promise<BoxExecResult> {
		const response = await this.json(
			"POST",
			`${this.box(boxId)}/commands`,
			input,
			undefined,
			z.object({ result: boxResultSchema }).parse
		);
		return response.result;
	}

	/**
	 * Runs a command and yields its output as it arrives. Ending the iteration
	 * early (or aborting `signal`) stops the command.
	 */
	async *execStream(
		boxId: string,
		input: BoxCommandInput,
		signal?: AbortSignal
	): AsyncGenerator<BoxStreamEvent> {
		const response = await this.request(
			"POST",
			`${this.box(boxId)}/commands`,
			JSON.stringify({ ...input, stream: true }),
			{ Accept: "text/event-stream", "Content-Type": "application/json" },
			signal
		);
		yield* this.streamEvents(response);
	}

	/** Starts a background process and returns at once. */
	async spawn(boxId: string, input: BoxCommandInput): Promise<BoxProcess> {
		const response = await this.json(
			"POST",
			`${this.box(boxId)}/commands`,
			{ ...input, background: true },
			undefined,
			z.object({ process: boxProcessSchema }).parse
		);
		return response.process;
	}

	async processes(boxId: string): Promise<BoxProcess[]> {
		const response = await this.json(
			"GET",
			`${this.box(boxId)}/processes`,
			undefined,
			undefined,
			z.object({ processes: z.array(boxProcessSchema) }).parse
		);
		return response.processes;
	}

	async process(boxId: string, processId: string): Promise<BoxProcess> {
		const response = await this.json(
			"GET",
			this.proc(boxId, processId),
			undefined,
			undefined,
			z.object({ process: boxProcessSchema }).parse
		);
		return response.process;
	}

	/** Retained output after sequence number `after`. */
	async logs(
		boxId: string,
		processId: string,
		after = 0
	): Promise<{ chunks: BoxOutputChunk[]; process: BoxProcess }> {
		return await this.json(
			"GET",
			`${this.proc(boxId, processId)}/logs${query({ after })}`,
			undefined,
			undefined,
			boxLogsSchema.parse
		);
	}

	/** Replays output after `after`, then follows the process until it exits. */
	async *followLogs(
		boxId: string,
		processId: string,
		options: { after?: number; signal?: AbortSignal } = {}
	): AsyncGenerator<BoxStreamEvent> {
		const response = await this.request(
			"GET",
			`${this.proc(boxId, processId)}/logs${query({ after: options.after, follow: "true" })}`,
			undefined,
			{ Accept: "text/event-stream" },
			options.signal
		);
		yield* this.streamEvents(response);
	}

	async kill(boxId: string, processId: string): Promise<BoxProcess> {
		const response = await this.json(
			"POST",
			`${this.proc(boxId, processId)}/kill`,
			undefined,
			undefined,
			z.object({ process: boxProcessSchema }).parse
		);
		return response.process;
	}

	async writeStdin(
		boxId: string,
		processId: string,
		data: string,
		options: { close?: boolean } = {}
	): Promise<void> {
		await this.json("POST", `${this.proc(boxId, processId)}/stdin`, {
			close: options.close ?? false,
			data,
		});
	}

	/** Kills every process the service is running in the Box. */
	async interrupt(boxId: string): Promise<number> {
		const response = await this.json(
			"POST",
			`${this.box(boxId)}/interrupt`,
			undefined,
			undefined,
			z.object({ killed: z.number() }).parse
		);
		return response.killed;
	}

	// --- Files -----------------------------------------------------------------------

	/** Lists a directory; paths are relative to /workspace unless absolute. */
	async listFiles(boxId: string, path = "."): Promise<BoxFileEntry[]> {
		const response = await this.json(
			"GET",
			`${this.box(boxId)}/files${query({ path })}`,
			undefined,
			undefined,
			z.object({ entries: z.array(boxFileSchema) }).parse
		);
		return response.entries;
	}

	async readFile(boxId: string, path: string): Promise<Uint8Array> {
		const response = await this.request(
			"GET",
			`${this.box(boxId)}/files/content${query({ path })}`
		);
		return new Uint8Array(await response.arrayBuffer());
	}

	async readTextFile(boxId: string, path: string): Promise<string> {
		return new TextDecoder().decode(await this.readFile(boxId, path));
	}

	async writeFile(
		boxId: string,
		path: string,
		data: Uint8Array | string
	): Promise<void> {
		await this.request(
			"PUT",
			`${this.box(boxId)}/files/content${query({ path })}`,
			z.string().safeParse(data).success
				? new TextEncoder().encode(z.string().parse(data))
				: new Uint8Array(z.instanceof(Uint8Array).parse(data)),
			{ "Content-Type": "application/octet-stream" }
		);
	}

	async makeDirectory(boxId: string, path: string): Promise<void> {
		await this.json("POST", `${this.box(boxId)}/files/directories`, { path });
	}

	async removePath(boxId: string, path: string): Promise<void> {
		await this.json("DELETE", `${this.box(boxId)}/files${query({ path })}`);
	}

	/** Streams a tar archive of `path`. */
	async downloadArchive(
		boxId: string,
		path = "."
	): Promise<ReadableStream<Uint8Array>> {
		const response = await this.request(
			"GET",
			`${this.box(boxId)}/files/archive${query({ path })}`
		);
		return this.body(response);
	}

	/** Extracts a tar archive into `path`. */
	async uploadArchive(
		boxId: string,
		path: string,
		tar: Uint8Array
	): Promise<void> {
		await this.request(
			"PUT",
			`${this.box(boxId)}/files/archive${query({ path })}`,
			new Uint8Array(tar),
			{ "Content-Type": "application/x-tar" }
		);
	}

	// --- Previews, terminals, tunnels and SSH ------------------------------------------

	/** Publishes a port inside the Box at a preview URL. Private previews need the API key. */
	async createPreview(
		boxId: string,
		port: number,
		visibility: "private" | "public" = "private"
	): Promise<BoxPreview> {
		const response = await this.json(
			"POST",
			`${this.box(boxId)}/previews`,
			{ port, visibility },
			undefined,
			z.object({ preview: boxPreviewSchema }).parse
		);
		return this.withAbsoluteUrl(response.preview);
	}

	async listPreviews(boxId: string): Promise<BoxPreview[]> {
		const response = await this.json(
			"GET",
			`${this.box(boxId)}/previews`,
			undefined,
			undefined,
			z.object({ previews: z.array(boxPreviewSchema) }).parse
		);
		return response.previews.map((preview) => this.withAbsoluteUrl(preview));
	}

	async deletePreview(boxId: string, token: string): Promise<void> {
		await this.json("DELETE", `${this.box(boxId)}/previews/${pathId(token)}`);
	}

	/** Mints a short-lived WebSocket URL for a terminal or a TCP tunnel to `port`. */
	async accessToken(
		boxId: string,
		scope: "terminal" | "tunnel",
		port?: number
	): Promise<BoxAccessToken>;
	/**
	 * Mints a single-use desktop stream token for `origin`. The service answers
	 * with an absolute `url` when it knows its public URL; otherwise the URL is
	 * built from `baseUrl`.
	 */
	async accessToken(
		boxId: string,
		request: BoxDesktopTokenInput
	): Promise<BoxDesktopAccessToken>;
	async accessToken(
		boxId: string,
		scopeOrRequest: "terminal" | "tunnel" | BoxDesktopTokenInput,
		port?: number
	): Promise<BoxAccessToken | BoxDesktopAccessToken> {
		if (typeof scopeOrRequest === "object") {
			const token = await this.json(
				"POST",
				`${this.box(boxId)}/access-tokens`,
				{
					origin: scopeOrRequest.origin,
					scope: "desktop",
					sub: scopeOrRequest.sub,
					viewOnly: scopeOrRequest.viewOnly ?? false,
				},
				undefined,
				boxDesktopTokenSchema.parse
			);
			return {
				expiresAt: token.expiresAt,
				protocols: token.protocols,
				token: token.token,
				url: this.socketUrl(token.url ?? `${this.box(boxId)}/desktop/ws`),
			};
		}
		const token = await this.json(
			"POST",
			`${this.box(boxId)}/access-tokens`,
			{ port, scope: scopeOrRequest },
			undefined,
			boxTokenSchema.parse
		);
		return { ...token, url: this.socketUrl(token.url) };
	}

	/**
	 * Opens an interactive shell. Send keystrokes as text or binary frames and
	 * `{ "type": "resize", "cols": 120, "rows": 40 }` to resize; output arrives
	 * as binary frames, and a final `{ "type": "exit" }` text frame ends it.
	 */
	async openTerminal(
		boxId: string,
		size: { cols?: number; rows?: number } = {}
	): Promise<WebSocket> {
		const { url } = await this.accessToken(boxId, "terminal");
		const target = new URL(url);
		if (size.cols) {
			target.searchParams.set("cols", String(size.cols));
		}
		if (size.rows) {
			target.searchParams.set("rows", String(size.rows));
		}
		return this.socket(target.toString());
	}

	/** Opens a raw TCP stream to `port` inside the Box over a WebSocket. */
	async openTunnel(boxId: string, port: number): Promise<WebSocket> {
		const { url } = await this.accessToken(boxId, "tunnel", port);
		return this.socket(url);
	}

	/** Authorizes `publicKey` and starts sshd inside the Box. */
	async enableSsh(boxId: string, publicKey: string): Promise<BoxSsh> {
		const response = await this.json(
			"POST",
			`${this.box(boxId)}/ssh`,
			{
				publicKey,
			},
			undefined,
			z.object({ ssh: boxSshSchema }).parse
		);
		return {
			...response.ssh,
			tunnelUrl: this.socketUrl(response.ssh.tunnelUrl),
		};
	}

	// --- Agent prompts -----------------------------------------------------------------

	/**
	 * Queues a coding-agent prompt. `managed` runs the provider's CLI inside the
	 * Box (credentials come from the Box's secrets); `worker` leaves it for an
	 * external worker to claim. A managed run may also set `cwd`, `env`, and
	 * `timeoutSeconds`.
	 */
	async prompt(boxId: string, input: BoxPromptInput): Promise<BoxPromptRun> {
		const response = await this.json(
			"POST",
			`${this.box(boxId)}/prompt`,
			input,
			undefined,
			z.object({ run: boxPromptSchema }).parse
		);
		return response.run;
	}

	/** One prompt run, including its result once it finishes. */
	async promptRun(boxId: string, runId: string): Promise<BoxPromptRun> {
		const response = await this.json(
			"GET",
			`${this.box(boxId)}/prompts/${pathId(runId)}`,
			undefined,
			undefined,
			z.object({ run: boxPromptSchema }).parse
		);
		return response.run;
	}

	/** Cancels an active managed run; a finished run is returned unchanged. */
	async cancelPrompt(boxId: string, runId: string): Promise<BoxPromptRun> {
		const response = await this.json(
			"POST",
			`${this.box(boxId)}/prompts/${pathId(runId)}/cancel`,
			undefined,
			undefined,
			z.object({ run: boxPromptSchema }).parse
		);
		return response.run;
	}

	async prompts(boxId: string, limit?: number): Promise<BoxPromptRun[]> {
		const response = await this.json(
			"GET",
			`${this.box(boxId)}/prompts${query({ limit })}`,
			undefined,
			undefined,
			z.object({ prompts: z.array(boxPromptSchema) }).parse
		);
		return response.prompts;
	}

	// --- Snapshots, secrets and usage --------------------------------------------------

	async snapshot(boxId: string, name?: string): Promise<BoxSnapshot> {
		const response = await this.json(
			"POST",
			`${this.box(boxId)}/snapshots`,
			name ? { name } : {},
			undefined,
			z.object({ snapshot: boxSnapshotSchema }).parse
		);
		return response.snapshot;
	}

	async listSnapshots(): Promise<BoxSnapshot[]> {
		return (
			await this.json(
				"GET",
				"/v1/snapshots",
				undefined,
				undefined,
				z.object({ snapshots: z.array(boxSnapshotSchema) }).parse
			)
		).snapshots;
	}

	/** Looks a snapshot up by id or name. */
	async getSnapshot(snapshot: string): Promise<BoxSnapshot> {
		const response = await this.json(
			"GET",
			`/v1/snapshots/${pathId(snapshot)}`,
			undefined,
			undefined,
			z.object({ snapshot: boxSnapshotSchema }).parse
		);
		return response.snapshot;
	}

	async deleteSnapshot(snapshot: string): Promise<void> {
		await this.json("DELETE", `/v1/snapshots/${pathId(snapshot)}`);
	}

	/** Stores an encrypted tenant secret; Boxes opt in by name. */
	async putSecret(name: string, value: string): Promise<void> {
		await this.json("PUT", `/v1/secrets/${pathId(name)}`, {
			value,
		});
	}

	async listSecrets(): Promise<{ name: string; updatedAt: string }[]> {
		return (
			await this.json(
				"GET",
				"/v1/secrets",
				undefined,
				undefined,
				z.object({ secrets: z.array(boxSecretSchema) }).parse
			)
		).secrets;
	}

	async deleteSecret(name: string): Promise<void> {
		await this.json("DELETE", `/v1/secrets/${pathId(name)}`);
	}

	/**
	 * Per-second running time and storage lifetime per Box, and each
	 * snapshot's size and lifetime, between `from` and `to` (default: the last
	 * 30 days). A window may span at most 31 days.
	 */
	async usage(options: { from?: string; to?: string } = {}): Promise<BoxUsage> {
		return await this.json(
			"GET",
			`/v1/usage${query(options)}`,
			undefined,
			undefined,
			boxUsageSchema.parse
		);
	}

	/** The tenant's running and stored Boxes and resource units against its limits. */
	async limits(): Promise<BoxLimits> {
		return await this.json(
			"GET",
			"/v1/limits",
			undefined,
			undefined,
			boxLimitsSchema.parse
		);
	}

	// --- Transport ---------------------------------------------------------------------

	private box(boxId: string): string {
		return `/v1/boxes/${pathId(boxId)}`;
	}

	private proc(boxId: string, processId: string): string {
		return `${this.box(boxId)}/processes/${pathId(processId)}`;
	}

	/** The service returns relative URLs unless it knows its public URL. */
	private absoluteUrl(url: string): string {
		return new URL(
			url,
			`${this.options.baseUrl.replace(TRAILING_SLASHES, "")}/`
		).toString();
	}

	private socketUrl(url: string): string {
		return this.absoluteUrl(url).replace(HTTP_SCHEME, "ws");
	}

	private withAbsoluteUrl(preview: BoxPreview): BoxPreview {
		return { ...preview, url: this.absoluteUrl(preview.url) };
	}

	private body(response: Response): ReadableStream<Uint8Array> {
		if (!response.body) {
			throw new Error("Ryu Box returned an empty body.");
		}
		return response.body;
	}

	private async *streamEvents(
		response: Response
	): AsyncGenerator<BoxStreamEvent> {
		for await (const frame of readServerSentEvents(this.body(response))) {
			const item = toStreamEvent(frame);
			if (item) {
				yield item;
			}
		}
	}

	private socket(url: string): WebSocket {
		const WebSocketImpl = this.options.webSocket ?? globalThis.WebSocket;
		if (!WebSocketImpl) {
			throw new Error("No WebSocket implementation; pass one as `webSocket`.");
		}
		const socket = new WebSocketImpl(url);
		socket.binaryType = "arraybuffer";
		return socket;
	}

	private json<T>(
		method: string,
		path: string,
		body: BoxJsonRequest | undefined,
		headers: Record<string, string> | undefined,
		decode: z.ZodType<T>["parse"]
	): Promise<T>;
	private json(
		method: string,
		path: string,
		body?: BoxJsonRequest,
		headers?: Record<string, string>
	): Promise<z.infer<typeof wireJsonSchema> | undefined>;
	private async json<T>(
		method: string,
		path: string,
		body?: BoxJsonRequest,
		headers?: Record<string, string>,
		decode?: z.ZodType<T>["parse"]
	) {
		const response = await this.request(
			method,
			path,
			body === undefined ? undefined : JSON.stringify(body),
			{ "Content-Type": "application/json", ...headers }
		);
		const text = await response.text();
		const value = text ? wireJsonSchema.parse(JSON.parse(text)) : undefined;
		return decode ? decode(value) : value;
	}

	private async request(
		method: string,
		path: string,
		body?: BodyInit,
		headers: Record<string, string> = {},
		signal?: AbortSignal
	): Promise<Response> {
		// Every path, not only `pathId` segments: an id that reaches a path any
		// other way still cannot resolve onto another route.
		assertSafeRequestPath("Box", path);
		const base = this.options.baseUrl.replace(TRAILING_SLASHES, "");
		const fetchImpl = this.options.fetch ?? globalThis.fetch;
		const response = await fetchImpl(`${base}${path}`, {
			body: body ?? null,
			headers: { Authorization: `Bearer ${this.options.apiKey}`, ...headers },
			method,
			signal: signal ?? null,
		});
		if (!response.ok) {
			const text = await response.text().catch(() => response.statusText);
			throw new Error(
				`Ryu Box: ${method} ${path} failed (${response.status}): ${text}`
			);
		}
		return response;
	}
}

/**
 * A fresh idempotency key. Node 18 exposes Web Crypto only behind a flag and
 * some React Native runtimes omit it, so fall back to a random string: the key
 * only has to be unique per request, not secret.
 */
function newIdempotencyKey(): string {
	const randomUUID = z
		.function({ input: [], output: z.string() })
		.safeParse(globalThis.crypto?.randomUUID);
	if (randomUUID.success) {
		return randomUUID.data.call(globalThis.crypto);
	}
	const random = () => Math.random().toString(36).slice(2, 12);
	return `${Date.now().toString(36)}-${random()}${random()}`;
}

export function createBoxClient(options: BoxClientOptions): BoxAPI {
	return new BoxAPI(options);
}
