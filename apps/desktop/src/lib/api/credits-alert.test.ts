import { describe, expect, it } from "bun:test";
import {
	CreditsError,
	isTerminalCreditsError,
	openCreditAlertStream,
} from "./credits.ts";

const realFetch = globalThis.fetch;

describe("openCreditAlertStream", () => {
	it("parses a credit-alert SSE frame", async () => {
		globalThis.fetch = Object.assign(
			() =>
				Promise.resolve(
					new Response(
						'event: credit-alert\ndata: {"balanceMicroUsd":1000000,"createdAt":"2026-08-16T00:00:00.000Z","level":"warning","thresholdMicroUsd":5000000,"title":"Your Ryu credit balance is low ($1.00)"}\n\n',
						{ headers: { "Content-Type": "text/event-stream" } }
					)
				),
			{ preconnect: realFetch.preconnect }
		);
		try {
			const stream = openCreditAlertStream(new AbortController().signal);
			await expect(stream.next()).resolves.toMatchObject({
				done: false,
				value: {
					data: {
						balanceMicroUsd: 1_000_000,
						level: "warning",
						thresholdMicroUsd: 5_000_000,
					},
					event: "credit-alert",
				},
			});
		} finally {
			globalThis.fetch = realFetch;
		}
	});

	for (const [status, kind, terminal] of [
		[401, "auth", true],
		[403, "access_policy", true],
		[409, "no_org", true],
		[500, "unknown", false],
	] as const) {
		it(`classifies a ${status} connect failure as ${kind}`, async () => {
			globalThis.fetch = Object.assign(
				() => Promise.resolve(new Response(null, { status })),
				{ preconnect: realFetch.preconnect }
			);
			try {
				const stream = openCreditAlertStream(new AbortController().signal);
				const failure = await stream.next().then(
					() => null,
					(error: unknown) => error
				);
				expect(failure).toBeInstanceOf(CreditsError);
				expect(failure).toMatchObject({ kind });
				expect(isTerminalCreditsError(failure)).toBe(terminal);
			} finally {
				globalThis.fetch = realFetch;
			}
		});
	}
});
