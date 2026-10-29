// apps/desktop/src/lib/api/credits.test.ts
//
// The wallet is ORG-level, so a signed-in user with no organization gets a 409
// from `/api/credits/wallet/stream` — forever, until they create or select one.
// `useWalletStream` reconnects on failure, and before this mapping existed every
// one of those reconnects was an identical 409 in the console for the life of
// the session, on the transient 500ms→10s cadence.
//
// The fix is a classification, and it spans two packages: `openSse` throws an
// `SseConnectError` carrying the HTTP status (packages/protocol), and
// `openWalletStream` re-throws it as the `CreditsError` kind the loop reads. The
// unit under test here is that hand-off — `SseConnectError` → `CreditsError` →
// `isTerminalCreditsError` — because a break anywhere along it is SILENT: the
// loop simply falls through to the transient branch and the spam is unchanged.

import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
	CreditsError,
	type CreditWallet,
	isTerminalCreditsError,
	openWalletStream,
	unrestrictedCreditBalanceMicroUsd,
} from "./credits.ts";

const realFetch = globalThis.fetch;

/** Point `fetch` at a fixed status, as the control plane would answer. */
function mockFetchStatus(status: number): void {
	globalThis.fetch = Object.assign(
		() => Promise.resolve(new Response(null, { status })),
		{ preconnect: realFetch.preconnect }
	);
}

function wallet(overrides: Partial<CreditWallet> = {}): CreditWallet {
	return {
		balanceMicroUsd: 0,
		currency: "usd",
		id: "wallet-1",
		ownerId: "org-1",
		ownerType: "organization",
		subscriptionBalanceMicroUsd: 0,
		topupBalanceMicroUsd: 0,
		updatedAt: "2026-09-24T00:00:00.000Z",
		...overrides,
	};
}

describe("unrestrictedCreditBalanceMicroUsd", () => {
	test("uses the server's authoritative unrestricted balance when present", () => {
		expect(
			unrestrictedCreditBalanceMicroUsd(
				wallet({
					balanceMicroUsd: 100_000_000,
					unrestrictedBalanceMicroUsd: 25_000_000,
				})
			)
		).toBe(25_000_000);
	});

	test("does not count provider-restricted grants toward retail managed usage", () => {
		expect(
			unrestrictedCreditBalanceMicroUsd(
				wallet({
					balanceBreakdownAvailable: true,
					balanceMicroUsd: 40_000_000,
					providerAllocations: [
						{
							expiresAt: null,
							isFreeProvider: true,
							label: "Ryu Fast",
							poolId: "fast",
							remainingMicroUsd: 40_000_000,
						},
					],
				})
			)
		).toBe(0);
	});

	test("uses prepaid and gift buckets when the total is decomposed locally", () => {
		expect(
			unrestrictedCreditBalanceMicroUsd(
				wallet({
					balanceBreakdownAvailable: true,
					balanceMicroUsd: 40_000_000,
					topupBalanceMicroUsd: 20_000_000,
					giftBalanceMicroUsd: 5_000_000,
				})
			)
		).toBe(25_000_000);
	});

	test("uses the aggregate balance when the provider does not expose a breakdown", () => {
		expect(
			unrestrictedCreditBalanceMicroUsd(
				wallet({
					balanceBreakdownAvailable: false,
					balanceMicroUsd: 12_000_000,
				})
			)
		).toBe(12_000_000);
	});

	test("clamps negative balances to zero", () => {
		expect(
			unrestrictedCreditBalanceMicroUsd(
				wallet({ unrestrictedBalanceMicroUsd: -1 })
			)
		).toBe(0);
	});
});

/** Drive the generator to its first `next()` and return whatever it threw. */
async function connectError(status: number) {
	mockFetchStatus(status);
	try {
		for await (const _message of openWalletStream(
			new AbortController().signal
		)) {
			// A mocked non-2xx never yields; reaching here is itself the failure.
			throw new Error("expected the connect to reject");
		}
		return null;
	} catch (e) {
		return z.instanceof(CreditsError).parse(e);
	} finally {
		globalThis.fetch = realFetch;
	}
}

describe("openWalletStream connect-failure classification", () => {
	test("maps a 409 to a terminal no_org CreditsError", async () => {
		const error = await connectError(409);
		expect(error).toBeInstanceOf(CreditsError);
		expect(error?.kind).toBe("no_org");
		// The whole point: the reconnect loop must read this as "retrying cannot
		// help", not as a blip worth another attempt in half a second.
		expect(isTerminalCreditsError(error)).toBe(true);
	});

	test("maps a 401 to a terminal auth CreditsError", async () => {
		const error = await connectError(401);
		expect(error?.kind).toBe("auth");
		expect(isTerminalCreditsError(error)).toBe(true);
	});

	// Not "auth": the session is valid, so "Sign in" copy would be wrong.
	test("maps a 403 access-policy refusal to a terminal access_policy CreditsError", async () => {
		const error = await connectError(403);
		expect(error?.kind).toBe("access_policy");
		expect(isTerminalCreditsError(error)).toBe(true);
	});

	// A restarting control plane must keep the fast cadence, or a deploy would
	// cost every client five minutes of stale balance.
	test("leaves a 500 transient", async () => {
		const error = await connectError(500);
		expect(error).toBeInstanceOf(CreditsError);
		expect(error?.kind).toBe("unknown");
		expect(isTerminalCreditsError(error)).toBe(false);
	});

	test("does not treat a non-CreditsError as terminal", () => {
		expect(isTerminalCreditsError(new Error("network down"))).toBe(false);
		expect(isTerminalCreditsError(null)).toBe(false);
	});
});
