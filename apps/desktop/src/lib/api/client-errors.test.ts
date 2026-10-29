import { describe, expect, test } from "bun:test";
import { parseApiErrorBody } from "./client-errors.ts";

describe("API error compatibility", () => {
	test("preserves legacy string errors", () => {
		expect(parseApiErrorBody('{"error":"Legacy refusal"}')).toEqual({
			message: "Legacy refusal",
		});
	});
	test("preserves safe structured messages and machine codes", () => {
		expect(
			parseApiErrorBody(
				'{"error":{"code":"cloud_runtime_unavailable","message":"Configure OpenSandbox to run this policy"}}'
			)
		).toEqual({
			code: "cloud_runtime_unavailable",
			message: "Configure OpenSandbox to run this policy",
		});
	});
	test("reads the top-level code of a control-plane refusal Core passed through", () => {
		expect(
			parseApiErrorBody(
				'{"code":"user_jwt_session_ended","error":"Unauthorized"}'
			)
		).toEqual({ code: "user_jwt_session_ended", message: "Unauthorized" });
		expect(parseApiErrorBody('{"code":7,"error":"Unauthorized"}')).toEqual({
			message: "Unauthorized",
		});
	});
	test("does not expose malformed or non-string structured fields", () => {
		expect(
			parseApiErrorBody('{"error":{"code":false,"message":{"token":"secret"}}}')
		).toEqual({ code: undefined, message: undefined });
	});
	test("tolerates non-JSON, null, and empty responses", () => {
		for (const body of ["", "null", "not json", '{"error":null}', "[]"]) {
			expect(parseApiErrorBody(body)).toEqual({});
		}
	});
});

test("projects missing and malformed structured fields without leaking additive details", () => {
	for (const error of [
		{},
		[],
		{ message: 12, code: null },
		{ message: "safe", secret: "hidden" },
	]) {
		const decoded = parseApiErrorBody(JSON.stringify({ error }));
		expect(Object.keys(decoded)).toEqual(["message", "code"]);
		expect(decoded).not.toHaveProperty("secret");
	}
});
