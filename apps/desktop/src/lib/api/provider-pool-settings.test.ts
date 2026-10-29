import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
	DEFAULT_POOL_AUTO_WEIGHTS,
	DEFAULT_POOL_EXECUTION,
	type GatewayProviderPool,
	LEGACY_PROVIDER_POOL_STRATEGIES,
	PROVIDER_POOL_STRATEGIES,
	providerPoolSettingsError,
	supportedProviderPoolStrategies,
} from "./gateway.ts";

type FixturePool = GatewayProviderPool & {
	members: [GatewayProviderPool["members"][number]];
};

function pool(
	strategy: GatewayProviderPool["strategy"] = "fusion"
): FixturePool {
	return {
		strategy,
		execution: { ...DEFAULT_POOL_EXECUTION },
		judge: { provider: "openai", model: "gpt-4o-mini" },
		members: [
			{
				provider: "openai",
				model: "gpt-4o-mini",
				priority: 0,
				weight: 1,
				enabled: true,
			},
		],
	};
}

test("pool strategy wires match the canonical Rust enum, including explicit serde names", async () => {
	const source = await readFile(
		new URL(
			"../../../../../crates/gateway/router/src/selection.rs",
			import.meta.url
		),
		"utf8"
	);
	const body = source.match(
		/pub enum CanonicalPoolStrategy\s*\{([\s\S]*?)\n\}/
	)?.[1];
	expect(body).toBeDefined();
	const wires: string[] = [];
	let rename: string | undefined;
	for (const line of (body ?? "").split("\n")) {
		const explicit = line.match(/#\[serde\(rename\s*=\s*"([^"]+)"\)\]/);
		if (explicit) {
			rename = explicit[1];
		}
		const variant = line.trim().match(/^([A-Z][A-Za-z0-9]*),?$/)?.[1];
		if (!variant) {
			continue;
		}
		wires.push(
			rename ?? variant.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase()
		);
		rename = undefined;
	}
	const clientWires: string[] = [...PROVIDER_POOL_STRATEGIES];
	expect(clientWires.sort()).toEqual(wires.sort());
	expect(LEGACY_PROVIDER_POOL_STRATEGIES).toEqual([
		"priority",
		"round_robin",
		"weighted_round_robin",
		"random",
		"least_used",
	]);
});

test("execution defaults match the canonical Rust configuration", async () => {
	const source = await readFile(
		new URL("../../../../../apps/gateway/src/config.rs", import.meta.url),
		"utf8"
	);
	const functions: {
		key: keyof typeof DEFAULT_POOL_EXECUTION;
		name: string;
	}[] = [
		{ key: "leg_timeout_ms", name: "default_pool_leg_timeout_ms" },
		{ key: "total_timeout_ms", name: "default_pool_total_timeout_ms" },
		{ key: "max_output_bytes", name: "default_pool_max_output_bytes" },
		{ key: "quorum", name: "default_pool_quorum" },
		{ key: "grace_ms", name: "default_pool_grace_ms" },
	];
	for (const { key, name } of functions) {
		const value = source.match(
			new RegExp(`fn ${name}\\(\\)\\s*->\\s*\\w+\\s*\\{\\s*([0-9_]+)\\s*\\}`)
		)?.[1];
		expect(value).toBeDefined();
		expect(DEFAULT_POOL_EXECUTION[key]).toBe(
			Number(value?.replaceAll("_", ""))
		);
	}
});

test("Auto weights match the pinned Rust defaults and preserve partial versus absent configuration", async () => {
	const source = await readFile(
		new URL(
			"../../../../../crates/gateway/router/src/selection.rs",
			import.meta.url
		),
		"utf8"
	);
	const block =
		source.match(
			/impl Default for AutoScoringWeights\s*\{[\s\S]*?Self \{([\s\S]*?)\n\s*\}/
		)?.[1] ?? "";
	const canonical = Object.fromEntries(
		[...block.matchAll(/\b([a-z_]+):\s*([0-9.]+),/g)].map((match) => [
			match[1],
			Number(match[2]),
		])
	);
	expect(canonical).toEqual(DEFAULT_POOL_AUTO_WEIGHTS);
	const configured = pool("auto");
	configured.judge = null;
	expect(configured.auto_weights).toBeUndefined();
	expect(providerPoolSettingsError(configured)).toBeNull();
	configured.auto_weights = { quality: 1 };
	expect(providerPoolSettingsError(configured)).toBeNull();
	expect(configured.auto_weights).toEqual({ quality: 1 });
	for (const weights of [
		{ quality: 0 },
		{ quality: -1 },
		{ quality: Number.NaN },
		{ quality: Number.POSITIVE_INFINITY },
		{ quality: 1001 },
	]) {
		configured.auto_weights = weights;
		expect(providerPoolSettingsError(configured)).not.toBeNull();
	}
});

test("an older node and a node advertising no strategies remain distinguishable", () => {
	expect(supportedProviderPoolStrategies()).toEqual(
		LEGACY_PROVIDER_POOL_STRATEGIES
	);
	expect(supportedProviderPoolStrategies([])).toEqual([]);
	expect(supportedProviderPoolStrategies(["fusion", "pipeline"])).toEqual([
		"fusion",
		"pipeline",
	]);
});

test("unknown context capacity is retained while invalid claimed capacity is rejected", () => {
	const configured = pool("context_optimized");
	configured.judge = null;
	expect(providerPoolSettingsError(configured)).toBeNull();
	for (const invalid of [0, -1, Number.NaN, 1.5, 2_000_001]) {
		configured.members[0].context_tokens = invalid;
		expect(providerPoolSettingsError(configured)).not.toBeNull();
	}
	configured.members[0].context_tokens = 2_000_000;
	expect(providerPoolSettingsError(configured)).toBeNull();
});

test("multi-target configuration rejects unbounded work and invalid deadlines", () => {
	for (const [field, value] of [
		["leg_timeout_ms", 30_001],
		["total_timeout_ms", 120_001],
		["max_output_bytes", 262_145],
		["quorum", 9],
		["grace_ms", 5001],
	] as const) {
		const configured = pool();
		configured.execution = { ...DEFAULT_POOL_EXECUTION, [field]: value };
		expect(providerPoolSettingsError(configured)).not.toBeNull();
	}
	const deadline = pool();
	deadline.execution = { ...DEFAULT_POOL_EXECUTION, total_timeout_ms: 29_999 };
	expect(providerPoolSettingsError(deadline)).not.toBeNull();
	const first = pool("pipeline").members[0];
	const oversized: GatewayProviderPool = {
		...pool("pipeline"),
		members: Array.from({ length: 9 }, (_, index) => ({
			...first,
			provider: `provider-${index}`,
		})),
	};
	expect(providerPoolSettingsError(oversized)).not.toBeNull();
});

test("member identity permits distinct models on one provider and rejects only exact collisions", () => {
	const configured: GatewayProviderPool = {
		...pool(),
		members: [pool().members[0], { ...pool().members[0], model: "gpt-4o" }],
	};
	expect(providerPoolSettingsError(configured)).toBeNull();
	const differentProvider: GatewayProviderPool = {
		...pool(),
		members: [
			pool().members[0],
			{ ...pool().members[0], provider: "anthropic" },
		],
	};
	expect(providerPoolSettingsError(differentProvider)).toBeNull();
	const duplicate: GatewayProviderPool = {
		...pool(),
		members: [pool().members[0], { ...pool().members[0] }],
	};
	expect(providerPoolSettingsError(duplicate)).not.toBeNull();
});

test("fusion requires a concrete synthesis target", () => {
	const configured = pool();
	configured.judge = { provider: "pool:recursive", model: "alias" };
	expect(providerPoolSettingsError(configured)).not.toBeNull();
	configured.judge = { provider: "openai", model: "" };
	expect(providerPoolSettingsError(configured)).not.toBeNull();
	configured.judge = { provider: "openai", model: "gpt-4o-mini" };
	expect(providerPoolSettingsError(configured)).toBeNull();
});
