import type { RequestConfirmationCode } from "@ryu/blocks/desktop/agent-elements/consent-host-context.tsx";
import type { McpOAuthFlow } from "@/src/lib/api/mcp-oauth.ts";
import { pollUntilConnected } from "./chat-consent-host-polling.ts";

export interface McpOAuthFlowDriver {
	/** Send the code the browser showed; resolves with the updated flow. */
	confirm(code: string): Promise<McpOAuthFlow>;
	fetchFlow(): Promise<McpOAuthFlow>;
}

function errorText(error: unknown, fallback: string): string {
	return error instanceof Error && error.message ? error.message : fallback;
}

/**
 * Wait for an MCP OAuth flow the browser is completing. A hosted node holds
 * the tokens after sign-in and stores them only once the user who started the
 * flow enters the code the browser shows, so this asks for it through
 * `requestCode` (again, with the refusal, after a wrong code) and confirms it.
 */
export async function waitForMcpOAuthConnection(
	driver: McpOAuthFlowDriver,
	requestCode: RequestConfirmationCode | undefined,
	signal: AbortSignal,
	appName: string
): Promise<void> {
	let awaitingCode = false;
	await pollUntilConnected(
		async () => {
			const flow = await driver.fetchFlow();
			if (flow.status === "failed") {
				throw new Error(flow.error ?? `Couldn't connect ${appName}.`);
			}
			awaitingCode = flow.status === "awaiting_confirmation";
			return awaitingCode || flow.status === "connected";
		},
		signal,
		appName
	);
	if (!awaitingCode) {
		return;
	}
	if (!requestCode) {
		throw new Error(
			`Enter the code your browser shows to finish connecting ${appName}.`
		);
	}
	const connectFailed = new Error(`Couldn't connect ${appName}.`);
	let previousError: string | null = null;
	for (;;) {
		const code = await requestCode(previousError, signal);
		try {
			const flow = await driver.confirm(code);
			if (flow.status === "connected") {
				return;
			}
			previousError = flow.error ?? connectFailed.message;
		} catch (error) {
			previousError = errorText(error, connectFailed.message);
		}
		// Too many wrong codes or an expired window fail the flow for good.
		const latest = await driver.fetchFlow();
		if (latest.status === "connected") {
			return;
		}
		if (latest.status !== "awaiting_confirmation") {
			throw new Error(latest.error ?? previousError);
		}
	}
}
