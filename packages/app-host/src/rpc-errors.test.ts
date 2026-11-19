import { describe, expect, test } from "bun:test";
import {
	AppRequestRpcError,
	CodedRpcError,
	isClientErrorStatus,
	MAX_RPC_REASON_LENGTH,
	rpcErrorCodeForStatus,
	sanitizeRpcReason,
	toRpcError,
} from "./rpc-errors.ts";

const PATH_FAILED = "/api/ext/@ryu/decks/decks/7 failed: 409";

describe("app.request failures", () => {
	test("relay the status and a 4xx reason beside the transport message", () => {
		expect(
			toRpcError(
				new AppRequestRpcError({
					message: PATH_FAILED,
					reason: "Plug the keyboard in first.",
					status: 409,
				})
			)
		).toEqual({
			code: "invalid_args",
			message: PATH_FAILED,
			reason: "Plug the keyboard in first.",
			status: 409,
		});
	});

	test("never carry a reason for a 5xx", () => {
		const error = new AppRequestRpcError({
			message: "/x failed: 500",
			reason: "storage error: disk I/O error",
			status: 500,
		});
		expect(error.reason).toBeUndefined();
		expect(toRpcError(error)).toEqual({
			code: "server_error",
			message: "/x failed: 500",
			status: 500,
		});
	});

	test("drop an empty or oversized reason", () => {
		for (const reason of ["   ", "x".repeat(MAX_RPC_REASON_LENGTH + 1)]) {
			expect(
				toRpcError(
					new AppRequestRpcError({ message: PATH_FAILED, reason, status: 400 })
				)
			).toEqual({ code: "invalid_args", message: PATH_FAILED, status: 400 });
		}
	});

	test("map each status family to a public code", () => {
		expect(rpcErrorCodeForStatus(401)).toBe("denied");
		expect(rpcErrorCodeForStatus(403)).toBe("denied");
		expect(rpcErrorCodeForStatus(404)).toBe("not_found");
		expect(rpcErrorCodeForStatus(410)).toBe("not_found");
		expect(rpcErrorCodeForStatus(402)).toBe("over_budget");
		expect(rpcErrorCodeForStatus(429)).toBe("over_budget");
		expect(rpcErrorCodeForStatus(422)).toBe("invalid_args");
		expect(rpcErrorCodeForStatus(503)).toBe("server_error");
		expect(isClientErrorStatus(499)).toBe(true);
		expect(isClientErrorStatus(500)).toBe(false);
	});
});

describe("sanitizeRpcReason", () => {
	test("deletes bidi and zero-width characters, spaces out controls", () => {
		const rlo = String.fromCodePoint(0x20_2e);
		const zwsp = String.fromCodePoint(0x20_0b);
		expect(sanitizeRpcReason(`a${rlo}b${zwsp}c\u0000d\u009Be\n\tf`)).toBe(
			"abc d e f"
		);
		expect(sanitizeRpcReason(`${rlo}\u0007`)).toBeUndefined();
		// Spelling joiners, emoji sequences and the soft hyphen survive.
		const zwnj = String.fromCodePoint(0x20_0c);
		const zwj = String.fromCodePoint(0x20_0d);
		const shy = String.fromCodePoint(0xad);
		expect(sanitizeRpcReason(`mi${zwnj}kh`)).toBe(`mi${zwnj}kh`);
		expect(sanitizeRpcReason(`a${zwj}b`)).toBe(`a${zwj}b`);
		expect(sanitizeRpcReason(`x${shy}y`)).toBe(`x${shy}y`);
		expect(sanitizeRpcReason(42)).toBeUndefined();
	});
});

describe("other errors keep their wire shape", () => {
	test("a coded error has no status or reason, even if it carries them", () => {
		const coded = Object.assign(new CodedRpcError("not_found", "gone"), {
			reason: "internal detail",
			status: 404,
		});
		expect(toRpcError(coded)).toEqual({ code: "not_found", message: "gone" });
	});

	test("a plain error stays a string", () => {
		expect(toRpcError(new Error("nope"))).toBe("nope");
	});
});
