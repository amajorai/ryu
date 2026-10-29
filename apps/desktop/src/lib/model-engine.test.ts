import { describe, expect, test } from "bun:test";
import type { NodeEngines } from "@/src/lib/api/models.ts";
import {
	type ModelEngineStatus,
	resolveModelEngine,
	waitForModelEngineInstall,
} from "./model-engine.ts";

function nodeEngines(
	engines: NodeEngines["formats"][number]["engines"],
	resident: string | null = null,
	supported = true
): NodeEngines {
	return {
		formats: [{ format: "gguf", supported, engines }],
		resident,
	};
}

function engine(
	name: string,
	installState: ModelEngineStatus["installState"],
	overrides: Partial<ModelEngineStatus> = {}
): ModelEngineStatus {
	return {
		deprecated: false,
		displayName: name,
		installState,
		name,
		supported: true,
		...overrides,
	};
}

describe("resolveModelEngine", () => {
	test("keeps the resident compatible engine when it is installed", () => {
		const resolved = resolveModelEngine(
			"gguf",
			nodeEngines(
				[
					{ name: "llamacpp", supported: true },
					{ name: "ollama", supported: true },
				],
				"ollama"
			),
			[
				engine("llamacpp", "installed"),
				engine("ollama", "installed", { displayName: "Ollama" }),
			]
		);

		expect(resolved).toEqual({
			displayName: "Ollama",
			installState: "installed",
			name: "ollama",
		});
	});

	test("prefers an installed compatible engine over an uninstalled first choice", () => {
		const resolved = resolveModelEngine(
			"gguf",
			nodeEngines([
				{ name: "llamacpp", supported: true },
				{ name: "ollama", supported: true },
			]),
			[engine("llamacpp", "not_installed"), engine("ollama", "installed")]
		);

		expect(resolved?.name).toBe("ollama");
	});

	test("keeps Core's engine order when no compatible engine is installed", () => {
		const resolved = resolveModelEngine(
			"gguf",
			nodeEngines([
				{ name: "llamacpp", supported: true },
				{ name: "ollama", supported: true },
			]),
			[engine("llamacpp", "not_installed"), engine("ollama", "not_installed")]
		);

		expect(resolved?.name).toBe("llamacpp");
	});

	test("returns no engine for an unsupported model format", () => {
		expect(
			resolveModelEngine("gguf", nodeEngines([], null, false), [])
		).toBeNull();
	});
});

describe("waitForModelEngineInstall", () => {
	const selectedEngine = { displayName: "llama.cpp" };

	test("waits until the engine install completes", async () => {
		const states: ModelEngineStatus["installState"][] = [
			"installing",
			"installed",
		];

		await expect(
			waitForModelEngineInstall(
				selectedEngine,
				async () => states.shift() ?? "installed",
				{ pollIntervalMs: 0 }
			)
		).resolves.toBeUndefined();
		expect(states).toEqual([]);
	});

	test("surfaces a failed installation", async () => {
		await expect(
			waitForModelEngineInstall(selectedEngine, async () => "failed")
		).rejects.toThrow("llama.cpp failed to install. Retry setup.");
	});

	test("times out with a useful next step", async () => {
		await expect(
			waitForModelEngineInstall(selectedEngine, async () => "not_installed", {
				pollIntervalMs: 0,
				timeoutMs: 0,
			})
		).rejects.toThrow("Check Engines and retry");
	});
});
