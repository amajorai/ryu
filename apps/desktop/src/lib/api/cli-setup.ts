import { invokeWhenReady } from "@/src/lib/tauri-ready.ts";

export type GatewayCliTool =
	| "claude-code"
	| "codex"
	| "opencode"
	| "gemini-cli"
	| "pi"
	| "droid"
	| "openclaw"
	| "hermes"
	| "continue"
	| "kilo"
	| "cline"
	| "iflow"
	| "qwen-code"
	| "grok-build"
	| "roo-code";

export interface GatewayCliSetupStatus {
	applied: boolean;
	configPath: string;
	conflict: boolean;
}

export function getGatewayCliSetupStatus(
	tool: GatewayCliTool
): Promise<GatewayCliSetupStatus> {
	return invokeWhenReady<GatewayCliSetupStatus>("gateway_cli_setup_status", {
		tool,
	});
}

export function applyGatewayCliSetup(input: {
	tool: GatewayCliTool;
	gatewayUrl: string;
	apiKey: string;
	model: string;
	modelLimits?: { contextTokens: number; outputTokens: number };
}): Promise<GatewayCliSetupStatus> {
	return invokeWhenReady<GatewayCliSetupStatus>(
		"apply_gateway_cli_setup",
		input
	);
}

export function resetGatewayCliSetup(
	tool: GatewayCliTool
): Promise<GatewayCliSetupStatus> {
	return invokeWhenReady<GatewayCliSetupStatus>("reset_gateway_cli_setup", {
		tool,
	});
}
