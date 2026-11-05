import { describe, expect, test } from "bun:test";
import { ApiError } from "@/src/lib/api/client-api-error.ts";
import type { McpOAuthFlow } from "@/src/lib/api/mcp-oauth.ts";
import { waitForMcpOAuthConnection } from "./chat-consent-host-mcp.ts";

function flow(
	status: McpOAuthFlow["status"],
	error: string | null = null,
	errorCode: string | null = null
): McpOAuthFlow {
	return {
		accessLevel: "risk_based",
		callbackMode: "hosted",
		error,
		errorCode,
		expiresAt: 0,
		flowId: "f",
		pluginId: "@ryu/mail",
		profileId: "personal",
		scopes: [],
		serverName: "mail",
		status,
	};
}

describe("waitForMcpOAuthConnection", () => {
	test("a held hosted flow is confirmed with the code the user enters", async () => {
		const asked: (string | null)[] = [];
		const sent: string[] = [];
		const states = [flow("awaiting_confirmation")];
		await waitForMcpOAuthConnection(
			{
				confirm(code) {
					sent.push(code);
					if (code === "WRONG") {
						return Promise.reject(
							new ApiError(
								"/confirm",
								400,
								"OAuth confirmation code did not match",
								"code_mismatch"
							)
						);
					}
					return Promise.resolve(flow("connected"));
				},
				fetchFlow: () => Promise.resolve(states[0] ?? flow("pending")),
			},
			(previousError) => {
				asked.push(previousError);
				return Promise.resolve(asked.length === 1 ? "WRONG" : "ABCD-EFGH");
			},
			new AbortController().signal,
			"Mail"
		);
		expect(sent).toEqual(["WRONG", "ABCD-EFGH"]);
		// The prompt shows the worded sentence for the code, not Core's English.
		expect(asked).toEqual([
			null,
			"That code didn't match. Check the code your browser shows and try again.",
		]);
	});

	test("a flow failed by too many wrong codes stops asking", async () => {
		let current = flow("awaiting_confirmation");
		let asked = 0;
		const outcome = waitForMcpOAuthConnection(
			{
				confirm() {
					current = flow(
						"failed",
						"Too many incorrect confirmation codes",
						"too_many_attempts"
					);
					return Promise.reject(new ApiError("/confirm", 400));
				},
				fetchFlow: () => Promise.resolve(current),
			},
			() => {
				asked += 1;
				return Promise.resolve("ZZZZ-ZZZZ");
			},
			new AbortController().signal,
			"Mail"
		);
		await expect(outcome).rejects.toThrow(
			"Too many incorrect codes. Connect Mail again to get a new code."
		);
		expect(asked).toBe(1);
	});

	test("a loopback flow that connects never asks for a code", async () => {
		let asked = false;
		await waitForMcpOAuthConnection(
			{
				confirm: () => Promise.reject(new Error("unexpected")),
				fetchFlow: () => Promise.resolve(flow("connected")),
			},
			() => {
				asked = true;
				return Promise.resolve("x");
			},
			new AbortController().signal,
			"Mail"
		);
		expect(asked).toBe(false);
	});
});
