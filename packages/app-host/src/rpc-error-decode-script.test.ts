// Behavior of the frame-side RPC result settlement fragments. They are evaluated
// exactly as the generated bootstraps run them: `msg` is the host result frame and
// `p` the pending entry. These pin today's decoding so a deliberate change to it
// shows up here as well as in the srcdoc parity digests.

import { describe, expect, it } from "bun:test";
import {
	companionRpcResultSettleScript,
	widgetRpcResultSettleScript,
} from "./rpc-error-decode-script.ts";

interface Outcome {
	rejected?: Error & { code?: unknown };
	resolved?: unknown;
}

function settle(fragment: string, msg: Record<string, unknown>): Outcome {
	const outcome: Outcome = {};
	const pending = {
		resolve: (value: unknown) => {
			outcome.resolved = value;
		},
		reject: (error: Error) => {
			outcome.rejected = error;
		},
	};
	new Function("msg", "p", fragment)(msg, pending);
	return outcome;
}

describe("companionRpcResultSettleScript", () => {
	const fragment = companionRpcResultSettleScript();

	it("resolves with the result when the frame carries no error", () => {
		expect(settle(fragment, { result: { ok: 1 } })).toEqual({
			resolved: { ok: 1 },
		});
	});

	it("rejects a legacy string error with that message and no code", () => {
		const { rejected } = settle(fragment, { error: "denied" });
		expect(rejected?.message).toBe("denied");
		expect(rejected && "code" in rejected).toBe(false);
	});

	it("rejects a structured error carrying its code", () => {
		const { rejected } = settle(fragment, {
			error: { code: "E_GRANT", message: "missing grant" },
		});
		expect(rejected?.message).toBe("missing grant");
		expect(rejected?.code).toBe("E_GRANT");
	});

	it("falls back to a generic message and omits an absent code", () => {
		const { rejected } = settle(fragment, { error: { detail: 1 } });
		expect(rejected?.message).toBe("error");
		expect(rejected && "code" in rejected).toBe(false);
	});
});

describe("widgetRpcResultSettleScript", () => {
	const fragment = widgetRpcResultSettleScript();

	it("resolves with the result when the frame carries no error", () => {
		expect(settle(fragment, { result: [1, 2] })).toEqual({ resolved: [1, 2] });
	});

	it("rejects a legacy string error with that message", () => {
		expect(settle(fragment, { error: "nope" }).rejected?.message).toBe("nope");
	});

	it("always assigns code on a structured error, even when absent", () => {
		const withCode = settle(fragment, {
			error: { code: "E_X", message: "bad" },
		}).rejected;
		expect(withCode?.message).toBe("bad");
		expect(withCode?.code).toBe("E_X");

		const withoutCode = settle(fragment, { error: {} }).rejected;
		expect(withoutCode?.message).toBe("error");
		expect(withoutCode && "code" in withoutCode).toBe(true);
		expect(withoutCode?.code).toBeUndefined();
	});
});

describe("relayed app.request failures", () => {
	const frame = {
		error: {
			code: "invalid_args",
			message: "/api/ext/@ryu/decks/decks failed: 409",
			reason: "Plug the keyboard in first.",
			status: 409,
		},
	};

	for (const [name, fragment] of [
		["companion", companionRpcResultSettleScript()],
		["widget", widgetRpcResultSettleScript()],
	] as const) {
		it(`the ${name} bootstrap exposes status and reason on the Error`, () => {
			const rejected = settle(fragment, frame).rejected as
				| (Error & { reason?: unknown; status?: unknown })
				| undefined;
			expect(rejected?.message).toBe("/api/ext/@ryu/decks/decks failed: 409");
			expect(rejected?.status).toBe(409);
			expect(rejected?.reason).toBe("Plug the keyboard in first.");
		});

		it(`the ${name} bootstrap ignores non-number status and non-string reason`, () => {
			const rejected = settle(fragment, {
				error: { code: "server_error", message: "x", reason: 1, status: "500" },
			}).rejected as
				| (Error & { reason?: unknown; status?: unknown })
				| undefined;
			expect(rejected && "status" in rejected).toBe(false);
			expect(rejected && "reason" in rejected).toBe(false);
		});
	}
});

describe("an empty string error", () => {
	for (const [name, fragment] of [
		["companion", companionRpcResultSettleScript()],
		["widget", widgetRpcResultSettleScript()],
	] as const) {
		it(`the ${name} bootstrap rejects it instead of resolving`, () => {
			const outcome = settle(fragment, { error: "" });
			expect(outcome.resolved).toBeUndefined();
			expect(outcome.rejected?.message).toBe("error");
		});
	}
});
