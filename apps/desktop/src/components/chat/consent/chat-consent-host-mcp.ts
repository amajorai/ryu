import type { RequestConfirmationCode } from "@ryu/blocks/desktop/agent-elements/consent-host-context.tsx";
import { translate as tl } from "@ryu/i18n/core";
import type { McpOAuthFlow } from "@/src/lib/api/mcp-oauth.ts";
import {
	mcpOAuthErrorText,
	mcpOAuthRefusalCode,
} from "@/src/lib/mcp-oauth-error-text.ts";
import { pollUntilConnected } from "./chat-consent-host-polling.ts";

export interface McpOAuthFlowDriver {
	/** Send the code the browser showed; resolves with the updated flow. */
	confirm(code: string): Promise<McpOAuthFlow>;
	fetchFlow(): Promise<McpOAuthFlow>;
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
				throw new Error(mcpOAuthErrorText(flow.errorCode, appName));
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
			tl("Enter the code your browser shows to finish connecting {appName}.", {
				appName,
			})
		);
	}
	let previousError: string | null = null;
	for (;;) {
		const code = await requestCode(previousError, signal);
		try {
			const flow = await driver.confirm(code);
			if (flow.status === "connected") {
				return;
			}
			previousError = mcpOAuthErrorText(flow.errorCode, appName);
		} catch (error) {
			previousError = mcpOAuthErrorText(mcpOAuthRefusalCode(error), appName);
		}
		// Too many wrong codes or an expired window fail the flow for good.
		const latest = await driver.fetchFlow();
		if (latest.status === "connected") {
			return;
		}
		if (latest.status !== "awaiting_confirmation") {
			throw new Error(
				latest.errorCode
					? mcpOAuthErrorText(latest.errorCode, appName)
					: previousError
			);
		}
	}
}
