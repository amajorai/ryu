import type { CatalogItem } from "@ryuhq/core-client/catalog.ts";
import type { ModelFormat, NodeEngines } from "@/src/lib/api/models.ts";

export interface ModelEngineStatus {
	deprecated: boolean;
	displayName: string;
	installState: CatalogItem["install_state"];
	name: string;
	supported: boolean;
}

export interface ModelEngineChoice {
	displayName: string;
	installState: ModelEngineStatus["installState"];
	name: string;
}

export interface InstallWaitOptions {
	pollIntervalMs?: number;
	timeoutMs?: number;
}

/** Wait until Core reports the selected inference engine installed or failed. */
export async function waitForModelEngineInstall(
	engine: Pick<ModelEngineChoice, "displayName">,
	readInstallState: () => Promise<ModelEngineStatus["installState"]>,
	{ pollIntervalMs = 1500, timeoutMs = 15 * 60 * 1000 }: InstallWaitOptions = {}
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const state = await readInstallState();
		if (state === "installed") {
			return;
		}
		if (state === "failed") {
			throw new Error(`${engine.displayName} failed to install. Retry setup.`);
		}
		if (Date.now() >= deadline) {
			throw new Error(
				`${engine.displayName} is taking longer than expected. Check Engines and retry.`
			);
		}
		await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
	}
}

/**
 * Resolve a model's serving engine from Core's ordered, node-specific capability
 * list. Reuse the resident engine when possible, then an installed compatible
 * engine, and only then the first supported engine that can be installed.
 */
export function resolveModelEngine(
	format: ModelFormat,
	nodeEngines: NodeEngines,
	catalog: ModelEngineStatus[]
): ModelEngineChoice | null {
	const formatSupport = nodeEngines.formats.find(
		(item) => item.format === format
	);
	if (!formatSupport?.supported) {
		return null;
	}

	const byName = new Map(catalog.map((engine) => [engine.name, engine]));
	const supported = formatSupport.engines
		.filter((engine) => engine.supported)
		.map((engine) => byName.get(engine.name))
		.filter(
			(engine): engine is ModelEngineStatus =>
				engine?.supported === true && !engine.deprecated
		)
		.map((engine) => ({
			name: engine.name,
			displayName: engine.displayName,
			installState: engine.installState,
		}));

	const resident = supported.find(
		(engine) =>
			engine.name === nodeEngines.resident &&
			engine.installState === "installed"
	);
	if (resident) {
		return resident;
	}

	return (
		supported.find((engine) => engine.installState === "installed") ??
		supported.find((engine) => engine.installState !== "installing") ??
		supported[0] ??
		null
	);
}
