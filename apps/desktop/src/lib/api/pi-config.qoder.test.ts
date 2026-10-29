import { expect, mock, test } from "bun:test";
import { z } from "zod";
import { gatewayJsonValueSchema } from "./gateway-json-contracts.ts";
import {
	configureProvider,
	discoverModels,
	updatePiConfig,
} from "./pi-config.ts";

test("Qoder regional credential save and discovery are separate from keyless activation", async () => {
	const originalFetch = globalThis.fetch;
	const bodySchema = z
		.object({ provider: z.string(), model: z.string().optional() })
		.catchall(gatewayJsonValueSchema);
	const calls: { path: string; body: z.output<typeof bodySchema> }[] = [];
	const fetchMock = mock(async (...args: Parameters<typeof fetch>) => {
		const path = new URL(String(args[0])).pathname;
		const body = bodySchema.parse(JSON.parse(String(args[1]?.body)));
		calls.push({ path, body });
		if (path === "/api/pi-config/providers") {
			return Response.json({
				apiTypes: [],
				thinkingLevels: [],
				providers: [
					{
						id: body.provider,
						label: "Qoder",
						api: "openai-completions",
						authEnv: "",
						authKind: "api-key",
						custom: false,
						routing: "direct",
						suggestedModels: [],
						configured: true,
						transport: "official-cli",
						cliAvailable: true,
					},
				],
			});
		}
		if (path === "/api/pi-config/discover-models") {
			return Response.json({
				source: "official-cli",
				models: [{ id: `${body.provider}-model` }],
			});
		}
		return Response.json({
			config: {
				provider: body.provider,
				model: body.model,
				routing: "direct",
				thinkingLevel: null,
				configDir: "isolated",
			},
		});
	});
	globalThis.fetch = Object.assign(fetchMock, { preconnect: () => undefined });
	try {
		for (const provider of ["qoder", "qoder-cn"]) {
			const target = {
				url: "http://qoder-fixture.test",
				token: null,
				userJwt: null,
			};
			await configureProvider(target, {
				provider,
				apiKey: "synthetic-personal-token",
				routing: "direct",
			});
			const roster = await discoverModels(target, { provider });
			await updatePiConfig(target, {
				provider,
				model: roster.models[0].id,
				thinkingLevel: null,
			});
		}
		expect(calls).toEqual(
			["qoder", "qoder-cn"].flatMap((provider) => [
				{
					path: "/api/pi-config/providers",
					body: {
						provider,
						apiKey: "synthetic-personal-token",
						routing: "direct",
					},
				},
				{ path: "/api/pi-config/discover-models", body: { provider } },
				{
					path: "/api/pi-config",
					body: { provider, model: `${provider}-model`, thinkingLevel: null },
				},
			])
		);
		for (const call of calls.filter(
			(item) => item.path !== "/api/pi-config/providers"
		)) {
			expect(call.body).not.toHaveProperty("apiKey");
		}
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("Qoder credential rejection propagates the Core error for the PAT error surface", async () => {
	const originalFetch = globalThis.fetch;
	const fetchMock = mock(async () =>
		Response.json(
			{ error: "Personal access token rejected for Qoder CN" },
			{ status: 400 }
		)
	);
	globalThis.fetch = Object.assign(fetchMock, { preconnect: () => undefined });
	try {
		await expect(
			configureProvider(
				{ url: "http://qoder-fixture.test", token: null, userJwt: null },
				{ provider: "qoder-cn", apiKey: "synthetic-token", routing: "direct" }
			)
		).rejects.toMatchObject({
			serverMessage: "Personal access token rejected for Qoder CN",
		});
	} finally {
		globalThis.fetch = originalFetch;
	}
});
