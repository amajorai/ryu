// The `ryu secrets agent` loop: log in, issue leases, render, then react.
//
// Everything that can happen later (a renewal timer, a vault change event, the
// render interval, a signal) is queued as a wake-up and handled one at a time,
// so a render, a renewal and a command never run concurrently. Failures that
// may pass (an outage) are retried after `retryMs`; the agent keeps running on
// the files it last wrote. It stops on SIGINT, SIGTERM or SIGHUP, revoking the
// leases it holds unless the config says otherwise.
//
// Change events need `list` on the keys a template reads: Core delivers an
// event only to callers that hold it. `renderInterval` re-renders on a timer
// for policies that do not grant it. When the event stream is lost after its
// reconnect attempts, the agent opens a new one after `retryMs` and renders
// again, because changes made in between are unknown.

import { openVaultAgentEventStream } from "@ryuhq/core-client/vault-events";
import { tf, tr } from "../i18n/translate.ts";
import {
	type AgentContext,
	agentTargetFor,
	authenticate,
	canLogInAgain,
	renewToken,
	type TokenState,
	writeSinks,
} from "./secrets-agentd-auth.ts";
import type { AgentConfig } from "./secrets-agentd-config.ts";
import {
	type HeldLease,
	issueLease,
	renewLease,
	revokeLeases,
} from "./secrets-agentd-leases.ts";
import {
	type LoadedTemplate,
	loadTemplates,
	renderAll,
} from "./secrets-agentd-render.ts";
import { type Clock, renewDelay, Timers } from "./secrets-agentd-schedule.ts";
import {
	ChangeFeed,
	DEFAULT_TIMING,
	LEASE_EVENT_TYPES,
	type Stop,
	VALUE_EVENT_TYPES,
	type WatchTiming,
} from "./secrets-watch.ts";

type Wake =
	| { kind: "token" }
	| { kind: "lease"; name: string }
	| { kind: "render" }
	| { kind: "feed" }
	| { kind: "event"; stop: Stop }
	| { kind: "stop"; signal: string };

/** Wake-ups in arrival order; `next` waits for one. */
class WakeQueue {
	private readonly items: Wake[] = [];
	private waiter: (() => void) | null = null;

	push(wake: Wake): void {
		this.items.push(wake);
		this.waiter?.();
		this.waiter = null;
	}

	stopRequested(): Wake | undefined {
		return this.items.find((wake) => wake.kind === "stop");
	}

	async next(): Promise<Wake> {
		while (this.items.length === 0) {
			await new Promise<void>((resolve) => {
				this.waiter = resolve;
			});
		}
		// A stop overtakes queued work.
		const stop = this.stopRequested();
		if (stop) {
			return stop;
		}
		return this.items.shift() as Wake;
	}
}

export interface DaemonOptions {
	clock: Clock;
	/** Render once and exit (leases stay valid until they expire). */
	once: boolean;
	/** Registers a SIGINT/SIGTERM/SIGHUP handler; returns its disposer. */
	onSignal: (handler: (signal: string) => void) => () => void;
	retryMs?: number;
	timing?: WatchTiming;
}

const DEFAULT_RETRY_MS = 30_000;

class AgentDaemon {
	private token: TokenState;
	private readonly leases = new Map<string, HeldLease>();
	/** Live set the change feed matches lease events against. */
	private readonly leaseIds = new Set<string>();
	private readonly queue = new WakeQueue();
	private readonly timers: Timers;
	private feed: AbortController | null = null;
	private readonly retryMs: number;

	constructor(
		private readonly ctx: AgentContext,
		private readonly config: AgentConfig,
		private readonly templates: LoadedTemplate[],
		private readonly options: DaemonOptions,
		token: TokenState
	) {
		this.token = token;
		this.timers = new Timers(options.clock);
		this.retryMs = options.retryMs ?? DEFAULT_RETRY_MS;
	}

	private target() {
		return agentTargetFor(this.ctx, this.token.token);
	}

	private say(text: string): void {
		this.ctx.io.err(`${text}\n`);
	}

	signalled(signal: string): void {
		this.queue.push({ kind: "stop", signal });
	}

	private setLease(held: HeldLease): void {
		const previous = this.leases.get(held.config.name);
		if (previous) {
			this.leaseIds.delete(previous.id);
		}
		this.leases.set(held.config.name, held);
		this.leaseIds.add(held.id);
		this.scheduleLease(held);
	}

	async issueAll(): Promise<void> {
		for (const lease of this.config.leases) {
			this.setLease(await issueLease(this.target(), lease));
		}
	}

	async render(): Promise<number> {
		const outcome = await renderAll(
			this.ctx,
			this.target(),
			this.config,
			this.templates,
			this.leases
		);
		return outcome.failed.length;
	}

	private scheduleToken(): void {
		if (this.token.expiresAtMs === null) {
			return;
		}
		const delay = renewDelay(this.options.clock.now(), this.token.expiresAtMs);
		this.timers.at("token", delay, () => this.queue.push({ kind: "token" }));
	}

	private scheduleLease(held: HeldLease): void {
		if (this.options.once || held.expiresAtMs === null) {
			return;
		}
		const name = held.config.name;
		const delay = renewDelay(this.options.clock.now(), held.expiresAtMs);
		this.timers.at(`lease:${name}`, delay, () =>
			this.queue.push({ kind: "lease", name })
		);
	}

	private scheduleInterval(): void {
		const interval = this.config.renderIntervalMs;
		if (interval !== null) {
			this.timers.at("interval", interval, () =>
				this.queue.push({ kind: "render" })
			);
		}
	}

	private retry(key: string, wake: Wake): void {
		this.say(
			tf("ryu agent: step {step} failed; retrying in {seconds}s.", {
				step: key,
				seconds: String(Math.round(this.retryMs / 1000)),
			})
		);
		this.timers.at(key, this.retryMs, () => this.queue.push(wake));
	}

	/** (Re)open the change feed on the current token. */
	async openFeed(): Promise<void> {
		this.feed?.abort();
		const controller = new AbortController();
		this.feed = controller;
		const filter = { types: [...VALUE_EVENT_TYPES, ...LEASE_EVENT_TYPES] };
		const target = this.target();
		const feed = new ChangeFeed(
			(signal) => openVaultAgentEventStream(target, filter, signal),
			this.options.timing ?? DEFAULT_TIMING,
			controller.signal
		);
		await feed.start();
		const pump = async () => {
			while (!controller.signal.aborted) {
				const stop = await feed.next(this.leaseIds);
				if (controller.signal.aborted) {
					return;
				}
				this.queue.push({ kind: "event", stop });
				if (stop.kind === "lost") {
					return;
				}
			}
		};
		pump().catch(() => undefined);
	}

	private async onToken(): Promise<number | null> {
		const renewed = await renewToken(this.ctx, this.token);
		if (renewed) {
			this.token = renewed;
		} else if (canLogInAgain(this.config.auth)) {
			this.token = await authenticate(this.ctx, this.config.auth);
			await writeSinks(this.config.sinks, this.token.token);
			this.say(tr("ryu agent: logged in again with a new vault token."));
			// The stream and every request captured the old token.
			await this.openFeed();
			this.queue.push({ kind: "render" });
		} else {
			this.say(
				tr(
					"ryu agent: the vault token can no longer be renewed, and the config has no login to replace it."
				)
			);
			return 1;
		}
		this.scheduleToken();
		return null;
	}

	private async replaceLease(name: string): Promise<void> {
		const lease = this.config.leases.find((entry) => entry.name === name);
		if (!lease) {
			return;
		}
		const held = await issueLease(this.target(), lease);
		this.setLease(held);
		this.say(
			tf("ryu agent: issued a new credential for lease {name} ({id}).", {
				name,
				id: held.id,
			})
		);
	}

	private async onLease(name: string): Promise<void> {
		const held = this.leases.get(name);
		if (!held) {
			return;
		}
		const renewed = await renewLease(this.target(), held);
		if (renewed) {
			this.setLease(renewed);
			return;
		}
		await this.replaceLease(name);
		await this.render();
	}

	private async onEvent(stop: Stop): Promise<void> {
		if (stop.kind === "lost") {
			// The stream gave up after its reconnects; the retry names the step.
			this.retry("feed", { kind: "feed" });
			return;
		}
		for (const held of [...this.leases.values()]) {
			if (stop.names.includes(held.id)) {
				await this.replaceLease(held.config.name);
			}
		}
		await this.render();
	}

	/** Handle one wake-up. Resolves an exit code to stop, else null. */
	private async handle(wake: Wake): Promise<number | null> {
		switch (wake.kind) {
			case "stop":
				this.say(
					tf("ryu agent: stopped by {signal}.", { signal: wake.signal })
				);
				return 0;
			case "token":
				return await this.onToken();
			case "lease":
				await this.onLease(wake.name);
				return null;
			case "feed":
				await this.openFeed();
				await this.render();
				return null;
			case "event":
				await this.onEvent(wake.stop);
				return null;
			default:
				await this.render();
				this.scheduleInterval();
				return null;
		}
	}

	/** Retry a failed step later. The step is named by its timer key
	 *  (`token`, `lease:NAME`, `feed`, `render`). */
	private retryWake(wake: Wake): void {
		const retryAs: Wake = wake.kind === "event" ? { kind: "render" } : wake;
		const key =
			retryAs.kind === "lease" ? `lease:${retryAs.name}` : retryAs.kind;
		this.retry(key, retryAs);
	}

	/** Schedule the token renewal and the render interval. Leases schedule
	 *  their own renewal when they are issued. */
	startTimers(): void {
		this.scheduleToken();
		this.scheduleInterval();
	}

	/** Handle wake-ups until one stops the agent. */
	async loop(): Promise<number> {
		while (true) {
			const wake = await this.queue.next();
			try {
				const code = await this.handle(wake);
				if (code !== null) {
					return code;
				}
			} catch {
				this.retryWake(wake);
			}
		}
	}

	async shutdown(revoke: boolean): Promise<void> {
		this.timers.cancelAll();
		this.feed?.abort();
		if (revoke) {
			await revokeLeases(this.target(), this.leases.values(), (text) =>
				this.ctx.io.err(text)
			);
		}
	}
}

/** Run the agent until a signal stops it (or once, with `options.once`). */
export async function runAgentDaemon(
	ctx: AgentContext,
	config: AgentConfig,
	options: DaemonOptions
): Promise<number> {
	const templates = await loadTemplates(config);
	const token = await authenticate(ctx, config.auth);
	await writeSinks(config.sinks, token.token);
	const daemon = new AgentDaemon(ctx, config, templates, options, token);
	const dispose = options.onSignal((signal) => daemon.signalled(signal));
	// A successful `--once` leaves the leases its files name valid; a daemon
	// (or a failed run) revokes them on exit.
	let keepLeases = false;
	try {
		await daemon.issueAll();
		if (!options.once) {
			// Subscribe before the first render, so no change slips between them.
			await daemon.openFeed();
			daemon.startTimers();
		}
		const failed = await daemon.render();
		if (options.once) {
			keepLeases = failed === 0;
			return failed > 0 ? 1 : 0;
		}
		// A signal during setup is already queued; the loop handles it first.
		return await daemon.loop();
	} finally {
		dispose();
		await daemon.shutdown(config.revokeLeasesOnExit && !keepLeases);
	}
}
