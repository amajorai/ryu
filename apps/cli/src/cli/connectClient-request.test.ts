import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
	ConnectError,
	parseServiceUrl,
	requestJson,
} from "./connectClient-request.ts";
import { localizedTextOf } from "./localizedText.ts";

const url = new URL("http://127.0.0.1:1/x");

async function caught(promise: Promise<unknown>): Promise<ConnectError> {
	const error = await promise.catch((value: unknown) => value);
	if (!(error instanceof ConnectError)) {
		throw new Error("expected a ConnectError");
	}
	return error;
}

describe("connect request plumbing", () => {
	test("service URL refusals are whole localized sentences", () => {
		const error = (() => {
			try {
				parseServiceUrl("http://connect.example.com", "connect");
			} catch (value) {
				return value as Error;
			}
			return null;
		})();
		expect(error?.message).toBe(
			"The Connect URL must use HTTPS (or HTTP to localhost) without credentials, a query or a fragment."
		);
		expect(() => parseServiceUrl("nope", "catalog")).toThrow(
			"The catalog URL must be an absolute URL."
		);
	});

	test("client-written refusals carry their ICU source and values", async () => {
		const unreachable = await caught(
			requestJson(
				() => Promise.reject(new Error("refused")),
				url,
				z.object({}),
				{},
				1000
			)
		);
		expect(unreachable.message).toBe("http://127.0.0.1:1 is unreachable.");
		expect(localizedTextOf(unreachable)?.source).toBe(
			"{origin} is unreachable."
		);
		const notJson = await caught(
			requestJson(
				() => Promise.resolve(new Response("<html>", { status: 502 })),
				url,
				z.object({}),
				{},
				1000
			)
		);
		expect(localizedTextOf(notJson)?.source).toBe(
			"The server answered HTTP {status} without JSON."
		);
		expect(notJson.message).toBe("The server answered HTTP 502 without JSON.");
	});

	test("a server's own error text stays as sent", async () => {
		const refused = await caught(
			requestJson(
				() =>
					Promise.resolve(
						Response.json({ code: "nope", error: "Nope." }, { status: 403 })
					),
				url,
				z.object({}),
				{},
				1000
			)
		);
		expect(refused.message).toBe("Nope.");
		expect(localizedTextOf(refused)).toBeNull();
	});
});
