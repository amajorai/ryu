import { expect, mock, test } from "bun:test";
import { readFile } from "node:fs/promises";

const calls: { command: string; input: unknown }[] = [];
const status = {
	applied: true,
	conflict: false,
	configPath: "isolated/config",
};
mock.module("@/src/lib/tauri-ready.ts", () => ({
	invokeWhenReady: <TInput>(command: string, input: TInput) => {
		calls.push({ command, input });
		return Promise.resolve(status);
	},
}));
const { applyGatewayCliSetup, getGatewayCliSetupStatus, resetGatewayCliSetup } =
	await import("./cli-setup.ts");

test("CLI projection invokes the three registered native commands with the selected connection", async () => {
	calls.length = 0;
	const input = {
		tool: "codex" as const,
		gatewayUrl: "http://127.0.0.1:12345",
		apiKey: "synthetic-proof-key",
		model: "selected-model",
	};
	expect(await getGatewayCliSetupStatus(input.tool)).toEqual(status);
	expect(await applyGatewayCliSetup(input)).toEqual(status);
	expect(await resetGatewayCliSetup(input.tool)).toEqual(status);
	expect(calls).toEqual([
		{ command: "gateway_cli_setup_status", input: { tool: input.tool } },
		{ command: "apply_gateway_cli_setup", input },
		{ command: "reset_gateway_cli_setup", input: { tool: input.tool } },
	]);
	const registered = await readFile(
		new URL("../../../src-tauri/src/lib.rs", import.meta.url),
		"utf8"
	);
	for (const call of calls) {
		expect(registered).toContain(`cli_setup::${call.command},`);
	}
});

test("Grok and Roo export use the registered reversible transport without returning credentials", async () => {
	calls.length = 0;
	for (const tool of ["grok-build", "roo-code"] as const) {
		const input = {
			tool,
			gatewayUrl: "https://gateway.example",
			apiKey: "synthetic-proof-key",
			model: "chosen-model",
			modelLimits: { contextTokens: 131_072, outputTokens: 8192 },
		};
		expect(await applyGatewayCliSetup(input)).toEqual(status);
		expect(await getGatewayCliSetupStatus(tool)).toEqual(status);
		expect(await resetGatewayCliSetup(tool)).toEqual(status);
	}
	expect(
		calls
			.filter((call) => call.command === "apply_gateway_cli_setup")
			.map((call) => call.input)
	).toEqual([
		{
			tool: "grok-build",
			gatewayUrl: "https://gateway.example",
			apiKey: "synthetic-proof-key",
			model: "chosen-model",
			modelLimits: { contextTokens: 131_072, outputTokens: 8192 },
		},
		{
			tool: "roo-code",
			gatewayUrl: "https://gateway.example",
			apiKey: "synthetic-proof-key",
			model: "chosen-model",
			modelLimits: { contextTokens: 131_072, outputTokens: 8192 },
		},
	]);
	expect(JSON.stringify(status)).not.toContain("synthetic-proof-key");
});
