// `ryu secrets run --watch`: keep the command running on current values.
//
// The CLI subscribes to Core's value-free vault event stream before the first
// export, so no change slips between the export and the subscription. When a
// value in the run's environment changes (or one of the run's leases is
// revoked or expires, or the stream reports it fell behind), the command is
// stopped, the values and leases are fetched again, and it starts anew. The
// command exiting on its own ends the watch with its exit code.
//
// The stream is the only way the CLI learns of changes, so losing it fails
// closed: the CLI reconnects a few times, and when that fails, or Core refuses
// the caller, it stops the command rather than leave it on values it can no
// longer follow.

import { ApiError } from "@ryuhq/core-client/client";
import {
	openVaultAgentEventStream,
	openVaultEventStream,
	type VaultEventFilter,
	type VaultEventMessage,
} from "@ryuhq/core-client/vault-events";
import { tf } from "../i18n/translate.ts";
import { flag, type SecretsArgs } from "./secrets-args.ts";
import { agentTarget } from "./secrets-output.ts";
import type { PreparedRun } from "./secrets-run-env.ts";
import type { CliContext } from "./types.ts";
import type { SignalGuard } from "./vaultIsolation.ts";

/** Event types that change which values a run receives. */
export const VALUE_EVENT_TYPES = [
	"kv-write",
	"kv-delete",
	"kv-destroy",
	"kv-import",
	"change-applied",
];
const LEASE_EVENT_TYPES = ["lease-revoke", "lease-expire"];

/** Opens one subscription; resolves once Core accepted it. */
export type EventSource = (
	signal: AbortSignal
) => Promise<AsyncGenerator<VaultEventMessage>>;

export interface WatchTiming {
	/** Quiet period that batches a burst of changes into one restart. */
	debounceMs: number;
	/** Waits before each reconnect attempt; its length is the attempt limit. */
	reconnectMs: number[];
}

export const DEFAULT_TIMING: WatchTiming = {
	debounceMs: 300,
	reconnectMs: [1000, 2000, 4000],
};

/** Drop value events from another environment. Lease events carry no
 *  environment, so they always pass; the feed matches them by lease id. */
export async function* onlyEnvironment(
	stream: AsyncGenerator<VaultEventMessage>,
	environment: string
): AsyncGenerator<VaultEventMessage> {
	for await (const message of stream) {
		if (
			message.kind === "event" &&
			VALUE_EVENT_TYPES.includes(message.event.type) &&
			message.event.environment !== environment
		) {
			continue;
		}
		yield message;
	}
}

/** The run's event source: the agent route under RYU_VAULT_TOKEN, else the
 *  person's route. The environment is filtered here, not by Core: Core's
 *  environment filter would also drop the run's own lease events. */
export function runEventSource(
	ctx: CliContext,
	args: SecretsArgs
): EventSource {
	const filter: VaultEventFilter = {
		types: [...VALUE_EVENT_TYPES, ...LEASE_EVENT_TYPES],
	};
	const environment = flag(args, "--env");
	const agent = agentTarget(ctx);
	const open = agent
		? (signal: AbortSignal) => openVaultAgentEventStream(agent, filter, signal)
		: (signal: AbortSignal) => openVaultEventStream(ctx.target, filter, signal);
	if (!environment) {
		return open;
	}
	return async (signal) => onlyEnvironment(await open(signal), environment);
}

/** Why a running command must stop. */
type Stop =
	| { kind: "change"; names: string[] }
	| { kind: "lost"; reason: string };

function sleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal.aborted || ms <= 0) {
			resolve();
			return;
		}
		const timer = setTimeout(resolve, ms);
		signal.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				resolve();
			},
			{ once: true }
		);
	});
}

function refused(error: unknown): boolean {
	return (
		error instanceof ApiError && (error.status === 401 || error.status === 403)
	);
}

/** Buffers events from the stream (reconnecting as allowed) and hands the
 *  watch loop the next reason to restart. */
class ChangeFeed {
	private readonly pending: VaultEventMessage[] = [];
	private lost: string | null = null;
	private wake: (() => void) | null = null;

	constructor(
		private readonly source: EventSource,
		private readonly timing: WatchTiming,
		private readonly signal: AbortSignal
	) {}

	/** Subscribe once; a refusal or outage here aborts the run before it starts. */
	async start(): Promise<void> {
		const stream = await this.source(this.signal);
		this.pump(stream).catch(() => undefined);
	}

	private push(): void {
		this.wake?.();
		this.wake = null;
	}

	private async pump(first: AsyncGenerator<VaultEventMessage>): Promise<void> {
		let stream: AsyncGenerator<VaultEventMessage> | null = first;
		let attempt = 0;
		while (!this.signal.aborted) {
			if (stream) {
				try {
					for await (const message of stream) {
						attempt = 0;
						this.pending.push(message);
						this.push();
					}
				} catch {
					// Ended by an outage; reconnect below.
				}
				stream = null;
			}
			if (this.signal.aborted) {
				return;
			}
			const wait = this.timing.reconnectMs[attempt];
			if (wait === undefined) {
				this.lost = "the vault event stream ended and could not be reopened";
				this.push();
				return;
			}
			attempt += 1;
			await sleep(wait, this.signal);
			try {
				stream = await this.source(this.signal);
				// Each successful reconnect earns the full retry budget again.
				attempt = 0;
				// Changes made while disconnected are unknown: refetch.
				this.pending.push({ kind: "lagged", skipped: 0 });
				this.push();
			} catch (error) {
				if (refused(error)) {
					this.lost = "Core refused the vault event stream";
					this.push();
					return;
				}
			}
		}
	}

	/** Forget what happened before a fresh export. */
	clear(): void {
		this.pending.length = 0;
	}

	private relevant(leaseIds: Set<string>): VaultEventMessage[] {
		return this.pending.filter(
			(message) =>
				message.kind === "lagged" ||
				VALUE_EVENT_TYPES.includes(message.event.type) ||
				(message.event.leaseId !== undefined &&
					leaseIds.has(message.event.leaseId))
		);
	}

	/** Resolves once a change affects the run (after the debounce) or the
	 *  stream is lost. */
	async next(leaseIds: Set<string>): Promise<Stop> {
		while (true) {
			if (this.lost) {
				return { kind: "lost", reason: this.lost };
			}
			if (this.relevant(leaseIds).length > 0) {
				await sleep(this.timing.debounceMs, this.signal);
				const names = this.relevant(leaseIds).flatMap((message) =>
					message.kind === "event"
						? [
								message.event.name ??
									message.event.leaseId ??
									message.event.type,
							]
						: ["(missed events)"]
				);
				this.clear();
				return { kind: "change", names: [...new Set(names)] };
			}
			await new Promise<void>((resolve) => {
				this.wake = resolve;
			});
		}
	}
}

export interface WatchRun {
	command: string[];
	events: EventSource;
	guard: SignalGuard;
	prepare: () => Promise<PreparedRun>;
	timing?: WatchTiming;
}

/** Run `command`, restarting it on every relevant vault change. */
export async function runWatching(
	ctx: Pick<CliContext, "io" | "spawn">,
	run: WatchRun
): Promise<number> {
	const stream = new AbortController();
	const feed = new ChangeFeed(
		run.events,
		run.timing ?? DEFAULT_TIMING,
		stream.signal
	);
	try {
		await feed.start();
		while (true) {
			run.guard.throwIfCancelled();
			feed.clear();
			const prepared = await run.prepare();
			const child = new AbortController();
			let exited = false;
			try {
				run.guard.forwardTo((signal) => {
					if (signal !== "SIGINT") {
						child.abort(signal);
					}
				});
				const exit = ctx
					.spawn(run.command, prepared.env, { signal: child.signal })
					.finally(() => {
						exited = true;
					});
				const outcome = await Promise.race([
					exit.then((code) => ({ kind: "exit" as const, code })),
					feed.next(prepared.leaseIds),
				]);
				if (outcome.kind === "exit") {
					return outcome.code;
				}
				child.abort("restart");
				const code = await exit;
				if (outcome.kind === "lost") {
					ctx.io.err(
						`${tf("ryu: {reason}; stopped the command so it does not keep running on values that are no longer watched.", { reason: outcome.reason })}\n`
					);
					return code === 0 ? 1 : code;
				}
				ctx.io.err(
					`${tf("ryu: vault values changed ({names}); restarting.", { names: outcome.names.join(", ") })}\n`
				);
			} finally {
				run.guard.forwardTo(null);
				if (!exited) {
					child.abort("stop");
				}
				await prepared.cleanup();
			}
		}
	} finally {
		stream.abort();
	}
}
