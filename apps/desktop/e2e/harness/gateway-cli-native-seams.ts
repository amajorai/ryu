import type { GatewayCliTool } from "../../src/lib/api/cli-setup.ts";

export { subscribeGatewayTraffic } from "../../src/lib/api/gateway.ts";

async function request<Input>(path: string, input?: Input) {
	const response = await fetch(`/__cli/${path}`, {
		method: input === undefined ? "GET" : "POST",
		headers: { "Content-Type": "application/json" },
		body: input === undefined ? undefined : JSON.stringify(input),
	});
	const value = await response.json();
	if (!response.ok) {
		throw new Error(value.error ?? "Native CLI proof request failed");
	}
	return value;
}

export function fetchGatewayConfig() {
	return request("config");
}
export function generateGatewayKey() {
	return `gwclient_${crypto.randomUUID().replaceAll("-", "")}`;
}
export function registerByoaKey<Target, Key>(_target: Target, key: Key) {
	return request("clients", key);
}
export function removeByoaKey<Target>(_target: Target, name: string) {
	return request("remove-client", { name });
}
export function getGatewayCliSetupStatus(tool: GatewayCliTool) {
	return request("setup", { action: "status", tool });
}
export function applyGatewayCliSetup(input: {
	tool: GatewayCliTool;
	gatewayUrl: string;
	apiKey: string;
	model: string;
	modelLimits?: { contextTokens: number; outputTokens: number };
}) {
	return request("setup", { ...input, action: "apply" });
}
export function resetGatewayCliSetup(tool: GatewayCliTool) {
	return request("setup", { tool, action: "reset" });
}
