// Shared fakes for the `ryu secrets agent` tests: a clock whose time moves only
// when a test advances it, and native-complete token fixtures.
// test-exempt: test fixtures, exercised by the secrets-agentd tests.

import type { Clock } from "../cli/secrets-agentd-schedule.ts";

export function fakeClock(start = 0) {
	let now = start;
	let nextId = 0;
	const timers = new Map<number, { at: number; callback: () => void }>();
	const clock: Clock = {
		now: () => now,
		setTimer: (callback, ms) => {
			nextId += 1;
			timers.set(nextId, { at: now + ms, callback });
			return nextId;
		},
		clearTimer: (handle) => {
			timers.delete(handle as number);
		},
	};
	return {
		clock,
		/** Move time forward, firing due timers in order. */
		advance(ms: number) {
			const until = now + ms;
			while (true) {
				const due = [...timers].filter(([, timer]) => timer.at <= until);
				due.sort((a, b) => a[1].at - b[1].at);
				const first = due[0];
				if (!first) {
					break;
				}
				timers.delete(first[0]);
				now = first[1].at;
				first[1].callback();
			}
			now = until;
		},
		pending: () => timers.size,
	};
}

export function tokenInfo(expiresAt: number, renewable = true) {
	return {
		accessor: "acc_1",
		identityId: "mid_1",
		policies: ["app"],
		parentAccessor: null,
		orphan: false,
		role: null,
		createdAt: 0,
		expiresAt,
		maxExpiresAt: null,
		periodSecs: null,
		numUsesRemaining: null,
		boundCidrs: [],
		lastUsedAt: null,
		revokedAt: null,
		renewable,
		ttlSecs: 3600,
	};
}

export function issuedToken(token: string) {
	return {
		token: {
			token,
			accessor: "acc_1",
			identityId: "mid_1",
			policies: ["app"],
			expiresAt: 3_600_000,
		},
	};
}

export function agentLease(id: string, expiresAt: number, renewable = true) {
	return {
		id,
		role: "db",
		provider: "postgres",
		issuedTo: null,
		createdAt: 0,
		expiresAt,
		maxExpiresAt: expiresAt * 10,
		renewable,
		revokedAt: null,
	};
}
