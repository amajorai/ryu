import type { GatewayCliTool } from "../../src/lib/api/cli-setup.ts";

const keys: Array<{
	key: string;
	name: string;
	trusted_forwarder: boolean;
	system_relay?: boolean;
}> = [
	{
		key: "***",
		name: "local-inference",
		trusted_forwarder: false,
		system_relay: true,
	},
];
const status = new Map<GatewayCliTool, boolean>([
	["claude-code", false],
	["codex", false],
	["opencode", false],
	["gemini-cli", false],
	["pi", false],
	["droid", false],
	["openclaw", false],
	["hermes", false],
	["continue", false],
	["kilo", false],
	["cline", false],
]);

export async function fetchGatewayConfig() {
	return { auth: { api_keys: [...keys], require_auth: true } };
}

export function generateGatewayKey() {
	return "sk-ryu-proof-only-00000000000000000000000000000000";
}

export async function registerByoaKey<Target>(
	_target: Target,
	key: (typeof keys)[number]
) {
	keys.push(key);
	return { ok: true };
}

export async function removeByoaKey<Target>(_target: Target, name: string) {
	const index = keys.findIndex((key) => key.name === name);
	if (index >= 0) {
		keys.splice(index, 1);
	}
	return { ok: true };
}

export function subscribeGatewayTraffic() {
	return () => undefined;
}

export async function getGatewayCliSetupStatus(tool: GatewayCliTool) {
	return {
		applied: status.get(tool),
		conflict: false,
		configPath: `C:/Users/Example/${tool}`,
	};
}

export async function applyGatewayCliSetup(input: { tool: GatewayCliTool }) {
	status.set(input.tool, true);
	return getGatewayCliSetupStatus(input.tool);
}

export async function resetGatewayCliSetup(tool: GatewayCliTool) {
	status.set(tool, false);
	return getGatewayCliSetupStatus(tool);
}
