import { expect, setSystemTime, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
	type DpopReplayReservations,
	verifyDpopProof,
} from "better-auth/oauth2";
import { createDpopKey, dpopProof } from "./mcp-oauth-flow.fixture.ts";
import {
	createDpopReplayStoreOutlivingWindow,
	DPOP_RESERVATION_MARGIN_MS,
} from "./oauth-dpop.ts";

/**
 * Better Auth's verification table, reduced to what a reservation touches: a
 * row per reservation id, and the cleanup every verification lookup runs
 * (rows whose `expiresAt` has passed are deleted).
 */
function verificationTable() {
	const rows = new Map<string, Date>();
	const reservations: DpopReplayReservations = {
		reserveVerificationValue: ({ identifier, expiresAt }) => {
			if (rows.has(identifier)) {
				return Promise.resolve(false);
			}
			rows.set(identifier, expiresAt);
			return Promise.resolve(true);
		},
	};
	const cleanup = () => {
		for (const [identifier, expiresAt] of rows) {
			if (expiresAt.getTime() < Date.now()) {
				rows.delete(identifier);
			}
		}
	};
	return { cleanup, reservations, rows };
}

test("reserves each proof for the margin past the end of its acceptance window", async () => {
	const reserved: { expiresAt: Date; identifier: string; value: string }[] = [];
	const store = createDpopReplayStoreOutlivingWindow({
		reserveVerificationValue: (data) => {
			reserved.push(data);
			return Promise.resolve(true);
		},
	});
	expect(
		await store.reserve({
			expiresAt: new Date(1_000_000),
			key: "replay-key",
			now: new Date(700_000),
		})
	).toBe(true);
	expect(reserved).toEqual([
		{
			expiresAt: new Date(1_000_000 + DPOP_RESERVATION_MARGIN_MS),
			identifier: "dpop-proof:replay-key",
			value: "replay-key",
		},
	]);
	expect(DPOP_RESERVATION_MARGIN_MS).toBeGreaterThanOrEqual(60_000);
});

test("a proof accepted in the last second of its window cannot be accepted again after a verification cleanup", async () => {
	const key = createDpopKey();
	const htu = "https://api.ryu.test/mcp/node-1";
	const second = 1_800_000_000;
	setSystemTime(new Date(second * 1000 + 100));
	try {
		const table = verificationTable();
		const replayStore = createDpopReplayStoreOutlivingWindow(
			table.reservations
		);
		const proofJwt = dpopProof(key, {
			htm: "POST",
			htu,
			iat: second - 300,
			jti: randomUUID(),
		});
		const check = () =>
			verifyDpopProof({ method: "POST", proofJwt, replayStore, url: htu });
		const accepted = await check();
		table.cleanup();
		const replayed = await check().then(
			() => "accepted",
			(error: unknown) => (error instanceof Error ? error.message : "refused")
		);
		expect(accepted.iat).toBe(second - 300);
		expect(table.rows.size).toBe(1);
		expect(replayed).toBe("DPoP proof jti has already been used");
	} finally {
		setSystemTime();
	}
});
