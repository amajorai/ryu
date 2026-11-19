import { describe, expect, test } from "bun:test";
import { toRpcError } from "@ryu/app-host/rpc-errors";
import { ApiError } from "@/src/lib/api/client.ts";
import {
	relayAppRequestFailure,
	withRelayedFailure,
} from "./app-request-failure.ts";

const PATH = "/api/ext/@ryu/places/trips/3";
const OWN = { sameApp: true };
const OTHER = { sameApp: false };
/** RIGHT-TO-LEFT OVERRIDE, built from its code point so the source stays visible. */
const RLO = String.fromCodePoint(0x20_2e);

describe("relayAppRequestFailure", () => {
	test("relays an own-app 4xx sentence with its status", () => {
		const relayed = relayAppRequestFailure(
			new ApiError(PATH, 409, "This trip changed since you opened it."),
			OWN
		);
		expect(toRpcError(relayed)).toEqual({
			code: "invalid_args",
			message: `${PATH} failed: 409`,
			reason: "This trip changed since you opened it.",
			status: 409,
		});
	});

	test("never relays a 5xx body: internal text stays in the host", () => {
		const internal = new ApiError(
			PATH,
			500,
			"storage error: no such table: trips"
		);
		const relayed = relayAppRequestFailure(internal, OWN);
		expect(relayed).toBe(internal);
		expect(toRpcError(relayed)).toBe(`${PATH} failed: 500`);
	});

	test("never relays another app's reason, only its status text", () => {
		const other = new ApiError(PATH, 409, "Team 'x' not found");
		expect(relayAppRequestFailure(other, OTHER)).toBe(other);
		expect(toRpcError(relayAppRequestFailure(other, OTHER))).toBe(
			`${PATH} failed: 409`
		);
	});

	test("keeps the old wire form when there is nothing to relay", () => {
		// Code-less: the plain string, exactly as before the relay.
		expect(
			toRpcError(relayAppRequestFailure(new ApiError(PATH, 404), OWN))
		).toBe(`${PATH} failed: 404`);
		// Coded: `{ code, message }` with the historical code mapping.
		expect(
			toRpcError(
				relayAppRequestFailure(
					new ApiError(PATH, 409, undefined, "conflict"),
					OWN
				)
			)
		).toEqual({ code: "server_error", message: `${PATH} failed: 409` });
	});

	test("keeps a public server code and the historical mapping of others", () => {
		expect(
			toRpcError(
				relayAppRequestFailure(new ApiError(PATH, 409, "Nope.", "denied"), OWN)
			)
		).toMatchObject({ code: "denied", reason: "Nope." });
		expect(
			toRpcError(
				relayAppRequestFailure(
					new ApiError(PATH, 409, "Nope.", "conflict"),
					OWN
				)
			)
		).toMatchObject({ code: "server_error", reason: "Nope." });
	});

	test("strips control and bidi characters from the relayed reason", () => {
		const relayed = relayAppRequestFailure(
			new ApiError(PATH, 400, `Name${RLO}gnp.exe\u0007 is\u0085 taken.`),
			OWN
		);
		expect(toRpcError(relayed)).toMatchObject({
			reason: "Namegnp.exe is taken.",
		});
	});

	test("passes other failures through unchanged", () => {
		const offline = new Error("companion document is closed");
		expect(relayAppRequestFailure(offline, OWN)).toBe(offline);
	});
});

describe("withRelayedFailure", () => {
	test("rejects with the relayed error and resolves untouched", async () => {
		const rejected = await withRelayedFailure(
			Promise.reject(
				new ApiError(PATH, 422, "Pick an end date after the start.")
			),
			OWN
		).catch((error: unknown) => error);
		expect(toRpcError(rejected)).toMatchObject({
			reason: "Pick an end date after the start.",
			status: 422,
		});
		expect(await withRelayedFailure(Promise.resolve(7), OWN)).toBe(7);
	});
});
