// Lease renewal for `ryu secrets run --lease ROLE` (with or without `--watch`).
//
// Each dynamic-credential lease the run issued is renewed while the command
// runs, at about two thirds of its remaining time, by `--lease-ttl` when given
// (else the role's default). Renewal stops for a lease that is not renewable
// or already expired. When renewal ends for a lease it had been renewing, or
// one Core refuses or no longer knows (the lease reached its maximum
// lifetime, a renewal no longer moves its expiry, or it was revoked), the CLI
// says when it expires and leaves the command running. Under `--watch` the expiry event
// restarts the command with a fresh lease. A failed request is retried a few
// times before the CLI gives up on that lease.
//
// `stop()` ends every loop and waits for a renewal already in flight, so the
// caller's revoke on exit is the last lease request. Nothing here prints a
// credential value; messages name the lease id, role and expiry only.

import { ApiError } from "@ryuhq/core-client/client";
import {
	type VaultLease,
	vaultAgentLease,
	vaultLease,
} from "@ryuhq/core-client/vault";
import { tf } from "../i18n/translate.ts";
import { agentTarget } from "./secrets-output.ts";
import type { CliContext } from "./types.ts";

/** Time source and wait, injectable so tests do not wait in real time. */
export interface RenewalClock {
	now: () => number;
	/** Resolves after `ms`, or as soon as `signal` aborts. */
	sleep: (ms: number, signal: AbortSignal) => Promise<void>;
}

export interface RenewalOptions {
	clock?: RenewalClock;
	/** Never renew sooner than this after the previous step. */
	minDelayMs?: number;
	/** Waits before each retry of a failed renewal; its length is the limit. */
	retryMs?: number[];
	/** The increment asked for on each renewal (`--lease-ttl`). */
	ttlSecs?: number;
}

export interface LeaseRenewal {
	/** Stop renewing and wait for any renewal in flight. */
	stop: () => Promise<void>;
}

export type RenewRequest = (
	id: string,
	ttlSecs?: number
) => Promise<VaultLease>;

const DEFAULT_MIN_DELAY_MS = 1000;
const DEFAULT_RETRY_MS = [1000, 5000, 15_000];

function realSleep(ms: number, signal: AbortSignal): Promise<void> {
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

export const SYSTEM_CLOCK: RenewalClock = {
	now: () => Date.now(),
	sleep: realSleep,
};

/** Core sends epoch milliseconds; an RFC 3339 string is accepted too. */
export function timestampMs(value: string | number | null): number | null {
	if (value === null) {
		return null;
	}
	if (typeof value === "number") {
		return Number.isFinite(value) ? value : null;
	}
	const parsed = Date.parse(value);
	return Number.isNaN(parsed) ? null : parsed;
}

/** Renew at two thirds of the remaining time, never sooner than `minDelayMs`. */
export function renewDelay(
	nowMs: number,
	expiresAtMs: number,
	minDelayMs: number
): number {
	return Math.max(minDelayMs, Math.floor(((expiresAtMs - nowMs) * 2) / 3));
}

function displayTime(value: string | number): string {
	const ms = timestampMs(value);
	return ms === null ? String(value) : new Date(ms).toISOString();
}

/** 400 (not renewable), 401/403 (refused) and 404 (unknown) will not change
 *  on a retry. */
function terminal(error: unknown): boolean {
	return (
		error instanceof ApiError && [400, 401, 403, 404].includes(error.status)
	);
}

/** Renews through the agent route under RYU_VAULT_TOKEN, else the person's. */
export function renewRequest(ctx: CliContext): RenewRequest {
	const agent = agentTarget(ctx);
	if (agent) {
		return async (id, ttlSecs) =>
			(await vaultAgentLease(agent, id, "renew", ttlSecs)).lease;
	}
	return async (id, ttlSecs) =>
		(await vaultLease(ctx.target, id, "renew", ttlSecs)).lease;
}

interface LoopContext {
	clock: RenewalClock;
	err: (text: string) => void;
	minDelayMs: number;
	renew: RenewRequest;
	retryMs: number[];
	signal: AbortSignal;
	ttlSecs?: number;
}

function giveUp(loop: LoopContext, lease: VaultLease): null {
	loop.err(
		`${tf("ryu: lease {id} ({role}) can no longer be renewed; it expires at {expiresAt}.", { id: lease.id, role: lease.role, expiresAt: displayTime(lease.expiresAt) })}\n`
	);
	return null;
}

/** One renewal with retries. Resolves the renewed lease, or null when the
 *  loop must end (reported, unless the run is stopping). */
async function renewOnce(
	loop: LoopContext,
	lease: VaultLease
): Promise<VaultLease | null> {
	for (let attempt = 0; ; attempt++) {
		try {
			return await loop.renew(lease.id, loop.ttlSecs);
		} catch (error) {
			const wait = loop.retryMs[attempt];
			if (loop.signal.aborted) {
				return null;
			}
			if (terminal(error) || wait === undefined) {
				return giveUp(loop, lease);
			}
			await loop.clock.sleep(wait, loop.signal);
			if (loop.signal.aborted) {
				return null;
			}
		}
	}
}

async function keepRenewed(loop: LoopContext, issued: VaultLease) {
	let lease = issued;
	while (!loop.signal.aborted && lease.renewable && lease.revokedAt === null) {
		const expiresAt = timestampMs(lease.expiresAt);
		const maxExpiresAt = timestampMs(lease.maxExpiresAt);
		if (expiresAt === null || expiresAt <= loop.clock.now()) {
			return;
		}
		if (maxExpiresAt !== null && expiresAt >= maxExpiresAt) {
			// Only worth saying once renewal had been keeping it alive.
			if (lease !== issued) {
				giveUp(loop, lease);
			}
			return;
		}
		await loop.clock.sleep(
			renewDelay(loop.clock.now(), expiresAt, loop.minDelayMs),
			loop.signal
		);
		if (loop.signal.aborted) {
			return;
		}
		const renewed = await renewOnce(loop, lease);
		if (renewed === null) {
			return;
		}
		const next = timestampMs(renewed.expiresAt);
		if (renewed.revokedAt !== null || next === null || next <= expiresAt) {
			giveUp(loop, renewed);
			return;
		}
		lease = renewed;
	}
}

/** Start renewing `leases` in the background; see the file comment. */
export function startLeaseRenewal(
	ctx: Pick<CliContext, "io">,
	leases: VaultLease[],
	renew: RenewRequest,
	options: RenewalOptions = {}
): LeaseRenewal {
	const controller = new AbortController();
	const loop: LoopContext = {
		clock: options.clock ?? SYSTEM_CLOCK,
		err: ctx.io.err,
		minDelayMs: options.minDelayMs ?? DEFAULT_MIN_DELAY_MS,
		renew,
		retryMs: options.retryMs ?? DEFAULT_RETRY_MS,
		signal: controller.signal,
		ttlSecs: options.ttlSecs,
	};
	const running = leases.map((lease) =>
		keepRenewed(loop, lease).catch(() => undefined)
	);
	return {
		stop: async () => {
			controller.abort();
			await Promise.all(running);
		},
	};
}
