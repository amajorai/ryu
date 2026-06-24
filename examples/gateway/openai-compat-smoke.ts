/**
 * Ryu Gateway — OpenAI-compat smoke test
 *
 * Sends a single chat completion to the locally running gateway and prints:
 *   - the x-provider response header (which upstream handled the call)
 *   - the assistant message text
 *
 * Prerequisites:
 *   1. Start the gateway: cargo run --manifest-path apps/gateway/Cargo.toml
 *   2. Set GATEWAY_API_KEY if require_auth = true in your gateway.toml,
 *      or leave unset for unauthenticated local dev.
 *
 * Run:
 *   bun run examples/gateway/openai-compat-smoke.ts
 *
 * Expected output:
 *   > Sending chat completion to http://127.0.0.1:7981/v1 ...
 *     x-provider: openai
 *     Response: <assistant message>
 *   > Smoke test passed.
 */

const GATEWAY_BASE_URL =
	process.env.GATEWAY_BASE_URL ?? "http://127.0.0.1:7981/v1";
const GATEWAY_API_KEY = process.env.GATEWAY_API_KEY ?? "dev-key";
const MODEL = process.env.GATEWAY_MODEL ?? "gpt-4o-mini";

async function runSmoke(): Promise<void> {
	console.log(`> Sending chat completion to ${GATEWAY_BASE_URL} ...`);

	const url = `${GATEWAY_BASE_URL}/chat/completions`;

	const body = JSON.stringify({
		model: MODEL,
		messages: [
			{
				role: "user",
				content: "Reply with exactly: Hello from the Ryu Gateway smoke test.",
			},
		],
		max_tokens: 64,
	});

	const response = await fetch(url, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${GATEWAY_API_KEY}`,
		},
		body,
	});

	if (!response.ok) {
		const text = await response.text();
		throw new Error(`Gateway returned ${response.status}: ${text}`);
	}

	// Print diagnostic headers added by the gateway
	const provider = response.headers.get("x-provider") ?? "(header absent)";
	const cached = response.headers.get("x-ryu-cached") ?? "false";
	const requestId = response.headers.get("x-ryu-request-id") ?? "(none)";

	console.log(`  x-provider:       ${provider}`);
	console.log(`  x-ryu-cached:     ${cached}`);
	console.log(`  x-ryu-request-id: ${requestId}`);

	const data = (await response.json()) as {
		choices?: Array<{ message?: { content?: string } }>;
	};

	const content = data.choices?.[0]?.message?.content ?? "(empty)";
	console.log(`  Response: ${content}`);

	// Validate the response shape — a real completion must have choices
	if (!data.choices || data.choices.length === 0) {
		throw new Error(
			"Response missing choices array — gateway or upstream error"
		);
	}

	console.log("> Smoke test passed.");
}

runSmoke().catch((err: unknown) => {
	const message = err instanceof Error ? err.message : String(err);
	console.error(`> Smoke test FAILED: ${message}`);
	process.exit(1);
});
