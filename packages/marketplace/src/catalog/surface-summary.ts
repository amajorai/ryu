import type {
	CatalogEntry,
	CatalogExtensionSummary,
	CatalogImplementationSummary,
	CatalogSurfaceSupport,
	PluginCatalogDetail,
} from "./types.ts";

/** The host relationship shared by the web, mobile, and browser-extension
 * clients. Keep this here because it describes Ryu's shell architecture, not a
 * publisher's runtime claim. */
const WRAPPED_SURFACES = new Map(
	Object.entries({
		extension: "desktop",
		mobile: "desktop",
		web: "desktop",
	})
);

const LEGACY_SURFACES = [
	"gateway",
	"core",
	"desktop",
	"island",
	"mobile",
	"extension",
	"web",
	"cli",
] as const;

/** Normalize a list while preserving the first declaration order. */
function unique(values: readonly string[]): string[] {
	const seen = new Set<string>();
	const output: string[] = [];
	for (const value of values) {
		const trimmed = value.trim();
		if (trimmed && !seen.has(trimmed)) {
			seen.add(trimmed);
			output.push(trimmed);
		}
	}
	return output;
}

/** Surface rows for the Marketplace support panel. New detail data wins over
 * the card; older cards fall back to their flattened surface list and finally
 * the manifest-era "all surfaces" default. */
export function surfaceSupportRows(
	detail: PluginCatalogDetail | null | undefined,
	entry: CatalogEntry
): CatalogSurfaceSupport[] {
	if (detail?.surfaceSupport && detail.surfaceSupport.length > 0) {
		return detail.surfaceSupport;
	}
	if (entry.surface_support && entry.surface_support.length > 0) {
		return entry.surface_support;
	}
	const names = detail?.surfaces ?? entry.surfaces ?? [];
	if (names.length > 0) {
		const supported = new Set(names);
		return unique(names).map((surface) => {
			const inheritedFrom = WRAPPED_SURFACES.get(surface);
			return {
				inheritedFrom:
					inheritedFrom && supported.has(inheritedFrom)
						? inheritedFrom
						: undefined,
				surface,
				support: "supported",
			};
		});
	}
	if (entry.descriptor_only) {
		return [];
	}
	return LEGACY_SURFACES.map((surface) => ({
		inheritedFrom: WRAPPED_SURFACES.get(surface),
		surface,
		support: "legacy",
	}));
}

/** Friendly support-level copy. The raw level is still rendered in the detail
 * data through the badge title, so unknown future levels remain understandable. */
export function surfaceSupportLabel(support?: string | null): string {
	switch (support?.toLowerCase()) {
		case "full":
			return "Full";
		case "limited":
			return "Limited";
		case "list":
			return "List only";
		case "commands":
			return "Commands";
		case "legacy":
			return "Legacy default";
		case "supported":
			return "Supported";
		default:
			return support?.trim() || "Supported";
	}
}

/** Short explanation of the host inheritance row. */
export function inheritedSurfaceLabel(
	inheritedFrom?: string | null
): string | null {
	return inheritedFrom?.toLowerCase() === "desktop"
		? "Uses the shared Desktop shell"
		: inheritedFrom
			? `Uses ${inheritedFrom} as its shell base`
			: null;
}

function capabilityTarget(capability: string): [string, string] {
	if (capability.startsWith("browser.")) {
		return ["browser", "Browser"];
	}
	if (capability.startsWith("computer.") || capability.startsWith("desktop.")) {
		return ["computer", "Computer"];
	}
	if (capability.startsWith("web.")) {
		return ["web", "Web"];
	}
	if (capability.startsWith("document.")) {
		return ["documents", "Document pipeline"];
	}
	return ["core", "Core capability"];
}

function addGroup(
	groups: Map<string, CatalogExtensionSummary>,
	target: string,
	label: string,
	features: readonly string[]
) {
	const cleanFeatures = unique(features);
	if (cleanFeatures.length === 0) {
		return;
	}
	const current = groups.get(target);
	if (current) {
		current.features = unique([...current.features, ...cleanFeatures]);
		return;
	}
	groups.set(target, { features: cleanFeatures, label, target });
}

function shellFeatures(
	api: NonNullable<PluginCatalogDetail["apiSurface"]>
): string[] {
	const features: string[] = [];
	if (api.views?.length) {
		features.push("host-rendered views");
	}
	if (api.settingsTabs?.length) {
		features.push("settings tabs");
	}
	if (api.composerControls?.length) {
		features.push("composer controls");
	}
	if (api.runnables?.some((runnable) => runnable.kind === "companion")) {
		features.push("companion UI");
	}
	return features;
}

/** Resolve the existing capabilities and contribution payload into a concise
 * "Extends" list when an older source has not yet supplied the server summary. */
export function extensionSummaries(
	detail: PluginCatalogDetail | null | undefined,
	entry: CatalogEntry
): CatalogExtensionSummary[] {
	if (detail?.extensions && detail.extensions.length > 0) {
		return detail.extensions;
	}
	const groups = new Map<string, CatalogExtensionSummary>();
	const layers = detail?.layers?.length ? detail.layers : (entry.layers ?? []);
	for (const layer of layers) {
		const [target, label] = capabilityTarget(layer.capability);
		const feature = layer.title?.trim()
			? `${layer.title.trim()} (${layer.capability})`
			: layer.capability;
		addGroup(groups, target, label, [feature]);
	}
	const api = detail?.apiSurface;
	if (api) {
		for (const provided of api.provides ?? []) {
			const [target, label] = capabilityTarget(provided.capability);
			addGroup(groups, target, label, [provided.capability]);
		}
		const shell = shellFeatures(api);
		addGroup(groups, "ryu-shell", "Shared Ryu shell", shell);
		const core = unique([
			...(api.runnables ?? [])
				.filter((runnable) => runnable.kind !== "companion")
				.map((runnable) => `${runnable.kind} runnable`),
			...(api.triggers?.turnHooks ?? []).map(() => "turn hooks"),
			...(api.triggers?.activationEvents ?? []).map(() => "activation events"),
			...(api.mcpServers ?? []).map(() => "MCP servers"),
			...(api.provides ?? []).map((provided) => provided.capability),
		]);
		addGroup(groups, "core", "Core runtime", core);
	}
	if (groups.size === 0 && (entry.capabilities?.length ?? 0) > 0) {
		addGroup(groups, "core", "Core runtime", entry.capabilities ?? []);
	}
	return [...groups.values()];
}

function addImplementationGroup(
	groups: Map<string, CatalogImplementationSummary>,
	layer: string,
	label: string,
	features: readonly string[]
) {
	const cleanFeatures = unique(features);
	if (cleanFeatures.length === 0) {
		return;
	}
	const current = groups.get(layer);
	if (current) {
		current.features = unique([...current.features, ...cleanFeatures]);
		return;
	}
	groups.set(layer, { features: cleanFeatures, label, layer });
}

/** Resolve the ownership boundaries a detail payload can prove. */
export function implementationSummaries(
	detail: PluginCatalogDetail | null | undefined,
	entry: CatalogEntry
): CatalogImplementationSummary[] {
	if (detail?.implementation && detail.implementation.length > 0) {
		return detail.implementation;
	}
	const groups = new Map<string, CatalogImplementationSummary>();
	const api = detail?.apiSurface;
	if (api) {
		const core = unique([
			...(api.runnables ?? [])
				.filter((runnable) => runnable.kind !== "companion")
				.map((runnable) => `${runnable.kind} runnable`),
			...(api.triggers?.turnHooks ?? []).map(() => "turn hooks"),
			...(api.mcpServers ?? []).map(() => "MCP registration"),
			...(api.provides ?? []).map(() => "capability broker"),
		]);
		addImplementationGroup(groups, "core", "Core runtime", core);
		addImplementationGroup(groups, "shared-shell", "Shared Ryu shell", [
			...shellFeatures(api),
		]);
		addImplementationGroup(
			groups,
			"sidecar",
			"Package sidecar",
			(api.sidecars ?? []).map((sidecar) => `${sidecar.name} process`)
		);
	}
	if (
		groups.size === 0 &&
		((entry.layers?.length ?? 0) > 0 || (entry.capabilities?.length ?? 0) > 0)
	) {
		addImplementationGroup(groups, "core", "Core runtime", [
			"capability and tool contract",
		]);
	}
	return [...groups.values()];
}
