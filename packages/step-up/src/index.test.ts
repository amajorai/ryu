import { describe, expect, it } from "bun:test";
import {
	createStepUpClient,
	isStepUpBlocking,
	isStepUpRequired,
	type StepUpStatus,
	stepUpPromptLine,
} from "./index.ts";

const status = {
	action: "change security settings",
	enrolmentRequired: false,
	methods: ["totp"],
	satisfied: false,
	scope: "account.security",
	twoFactorEnabled: true,
	windowMs: 300_000,
} satisfies StepUpStatus;

function clientForResponse(response: Response) {
	return createStepUpClient({
		baseUrl: "https://api.example.test/",
		fetch: Object.assign(async () => response, { preconnect() {} }),
	});
}

describe("step-up response boundaries", () => {
	it("accepts both supported required-error envelopes", () => {
		expect(isStepUpRequired({ error: "STEP_UP_REQUIRED" })).toBe(true);
		expect(isStepUpRequired({ error: { code: "STEP_UP_REQUIRED" } })).toBe(
			true
		);
		for (const value of [
			null,
			42,
			{ error: "other" },
			{ error: { code: 42 } },
		]) {
			expect(isStepUpRequired(value)).toBe(false);
		}
	});

	it("decodes the server status before exposing it to a surface", async () => {
		expect(
			await clientForResponse(Response.json(status)).status("account.security")
		).toEqual(status);
		await expect(
			clientForResponse(
				Response.json({ ...status, methods: ["invalid"] })
			).status("account.security")
		).rejects.toThrow();
		await expect(
			clientForResponse(
				Response.json({ ...status, windowMs: "300000" })
			).status("account.security")
		).rejects.toThrow();
	});

	it("preserves JSON message precedence, plain text, and page-dump fallback", async () => {
		for (const [body, message] of [
			[
				JSON.stringify({ message: "  Try again  ", error: "other" }),
				"Try again",
			],
			[JSON.stringify({ error: "Wrong code" }), "Wrong code"],
			["Wrong code", "Wrong code"],
			["<html>Proxy failure</html>", "Request failed (403)"],
		]) {
			await expect(
				clientForResponse(new Response(body, { status: 403 })).verify({
					code: "123456",
					method: "totp",
					scope: "account.security",
				})
			).rejects.toThrow(message);
		}
	});

	it("turns the email-cooldown 429 into the user-facing wait with its status, and keeps a 500 apart", async () => {
		// The exact answer `POST /api/step-up/challenge` gives inside the
		// per-recipient email cooldown.
		const cooldown = await clientForResponse(
			Response.json(
				{
					error: "Please wait 40 seconds before requesting another email.",
					retryAfter: 40,
				},
				{ headers: { "Retry-After": "40" }, status: 429 }
			)
		)
			.challenge("org.members")
			.then(
				() => null,
				(error: unknown) => error
			);
		expect(cooldown).toBeInstanceOf(Error);
		expect(cooldown).toMatchObject({
			message: "Please wait 40 seconds before requesting another email.",
			name: "StepUpRequestError",
			retryAfter: 40,
			status: 429,
		});

		// The API router's answer to any other failure.
		const failure = await clientForResponse(
			Response.json({ error: "Internal Server Error" }, { status: 500 })
		)
			.challenge("org.members", "magic-link")
			.then(
				() => null,
				(error: unknown) => error
			);
		expect(failure).toMatchObject({
			message: "Internal Server Error",
			name: "StepUpRequestError",
			status: 500,
		});
		expect((failure as { retryAfter?: number }).retryAfter).toBeUndefined();
	});

	it("reads a cooldown's wait from Retry-After when the body has none, and leaves a wait without a number unset", async () => {
		const refusedWith = (response: Response) =>
			clientForResponse(response)
				.challenge("org.members")
				.then(
					() => null,
					(error: unknown) => error as { retryAfter?: number; status: number }
				);
		const headerOnly = await refusedWith(
			Response.json(
				{ error: "Please wait before requesting another email." },
				{ headers: { "Retry-After": "12.5" }, status: 429 }
			)
		);
		expect(headerOnly?.retryAfter).toBe(13);
		const noWait = await refusedWith(
			Response.json(
				{ error: "Please wait a moment before requesting another email." },
				{ status: 429 }
			)
		);
		expect(noWait?.status).toBe(429);
		expect(noWait?.retryAfter).toBeUndefined();
	});

	it("names no wait on a refusal that is not a cooldown, even with Retry-After", async () => {
		const unavailable = await clientForResponse(
			Response.json(
				{ error: "Service Unavailable", retryAfter: 30 },
				{ headers: { "Retry-After": "30" }, status: 503 }
			)
		)
			.challenge("org.members")
			.then(
				() => null,
				(error: unknown) => error as { retryAfter?: number; status: number }
			);
		expect(unavailable?.status).toBe(503);
		expect(unavailable?.retryAfter).toBeUndefined();
	});

	it("takes a wait only from a positive number or decimal digits, never a boolean, array or date", async () => {
		const waitOf = async (bodyWait: unknown, header?: string) => {
			const refused = await clientForResponse(
				Response.json(
					{ error: "Please wait.", retryAfter: bodyWait },
					{
						headers: header === undefined ? {} : { "Retry-After": header },
						status: 429,
					}
				)
			)
				.challenge("org.members")
				.then(
					() => null,
					(error: unknown) => error as { retryAfter?: number }
				);
			return refused?.retryAfter;
		};
		expect(await waitOf(true)).toBeUndefined();
		expect(await waitOf([30])).toBeUndefined();
		expect(await waitOf("30")).toBe(30);
		expect(await waitOf(-5)).toBeUndefined();
		expect(await waitOf(0)).toBeUndefined();
		expect(await waitOf(null, "Wed, 21 Oct 2026 07:28:00 GMT")).toBeUndefined();
		expect(await waitOf(true, "45")).toBe(45);
	});

	it("sends the supplied credentials and JSON challenge with normalized headers", async () => {
		const calls: Array<{
			headers: Headers;
			url: string;
			credentials: RequestInit["credentials"];
			body: RequestInit["body"];
		}> = [];
		const fetchFixture: typeof fetch = Object.assign(
			async (
				input: Parameters<typeof fetch>[0],
				init?: Parameters<typeof fetch>[1]
			) => {
				calls.push({
					url: input instanceof Request ? input.url : String(input),
					headers: new Headers(init?.headers),
					credentials: init?.credentials,
					body: init?.body,
				});
				return new Response(null, { status: 204 });
			},
			{ preconnect() {} }
		);
		const client = createStepUpClient({
			baseUrl: "https://api.example.test///",
			fetch: fetchFixture,
			headers: () => ({ Authorization: "Bearer test" }),
			includeCredentials: true,
		});
		await client.challenge("account.security");
		expect(calls[0]?.url).toBe(
			"https://api.example.test/api/step-up/challenge"
		);
		expect(calls[0]?.headers.get("authorization")).toBe("Bearer test");
		expect(calls[0]?.headers.get("content-type")).toBe("application/json");
		expect(calls[0]?.credentials).toBe("include");
		expect(calls[0]?.body).toBe('{"method":"otp","scope":"account.security"}');
	});
});

describe("billing step-up presentation", () => {
	it("marks billing confirmation as blocking", () => {
		expect(isStepUpBlocking("billing")).toBe(true);
		expect(isStepUpBlocking("org.delete")).toBe(false);
	});

	it("names the authenticator code", () => {
		expect(
			stepUpPromptLine({
				action: "complete this billing action",
				method: "totp",
			})
		).toBe(
			"Enter the code from your authenticator app to complete this billing action."
		);
	});
});
