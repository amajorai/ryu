import { describe, expect, test } from "bun:test";
import { getEngineLaunchConfig, getEngineSamplingConfig } from "./inference.ts";

async function withPreference<T>(
	value: string | null,
	read: (target: { url: string; token: null }) => Promise<T>
): Promise<T> {
	const server = Bun.serve({
		port: 0,
		fetch: () => Response.json({ value }),
	});
	try {
		return await read({ url: server.url.toString(), token: null });
	} finally {
		server.stop(true);
	}
}

describe("persisted inference boundaries", () => {
	test("preserves known controls and future JSON parameters", async () => {
		const value = {
			temperature: 0.4,
			grammar: "root ::= 'yes'",
			extra: { vendor: { enabled: true } },
			response_format: { type: "json_object" },
			future: [1, "value"],
		};
		expect(
			await withPreference(JSON.stringify(value), (target) =>
				getEngineSamplingConfig(target, "llamacpp")
			)
		).toEqual(value);
	});

	test("validates persisted fields before they reach engine editors", async () => {
		await expect(
			withPreference('{"temperature":"hot"}', (target) =>
				getEngineSamplingConfig(target, "llamacpp")
			)
		).rejects.toThrow();
		await expect(
			withPreference('{"gpu_layers":"all"}', (target) =>
				getEngineLaunchConfig(target, "llamacpp")
			)
		).rejects.toThrow();
	});

	test("retains the absent and non-object preference fallback", async () => {
		for (const value of [null, "null", "[]", '"legacy"']) {
			expect(
				await withPreference(value, (target) =>
					getEngineLaunchConfig(target, "llamacpp")
				)
			).toEqual({});
		}
	});
});
