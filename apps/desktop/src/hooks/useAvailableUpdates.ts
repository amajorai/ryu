// apps/desktop/src/hooks/useAvailableUpdates.ts
//
// Aggregates "an update is available" across every artifact Ryu can update, so
// the download center can promote them as suggested downloads (popup + full
// page). Detection already lives per-type in Core; this hook is the single
// client-side join that surfaces them uniformly:
//   - app        : the release-train binary (core/gateway/cli/desktop) via
//                  /api/update/check — installed by the native updater, NOT the
//                  download center, so its apply hands off to `installUpdate`.
//   - agent      : /api/agents/catalog `version_status === "behind_latest"`.
//   - engine/tool/voice/media : /api/catalog installed_version != latest_version.
//   - plugin     : /api/plugins (installedVersion) vs /api/plugins/catalog version.
//   - skill/mcp/model : added as their Core detection lands (slices 2-4); the
//                  UI already renders whatever this hook returns.
//
// Every source reuses the same react-query key the owning Store section uses, so
// opening the popup does not trigger a fresh upstream (npm/GitHub) fan-out —
// Core additionally caches the upstream versions (VersionCache).
//
// Per the Core-vs-Gateway rule this is a Core-facing concern (it decides *what
// runs*, i.e. which build). No Gateway policy is evaluated here.

import { useMutation, useQueries, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { installUpdate } from "@/src/components/updater/AutoUpdater.tsx";
import { fetchAgentCatalog, runAgentUpdate } from "@/src/lib/api/agents.ts";
import { type ApiTarget, toTarget } from "@/src/lib/api/client.ts";
import { installMcpServer, listMcpUpdates } from "@/src/lib/api/mcp.ts";
import { installModelFile, listModelUpdates } from "@/src/lib/api/models.ts";
import {
	fetchApps,
	fetchAppsCatalog,
	updateInstalledPlugin,
} from "@/src/lib/api/plugins.ts";
import { installSkill, listSkillUpdates } from "@/src/lib/api/skills.ts";
import { checkForUpdate, type UpdateCheck } from "@/src/lib/api/update.ts";
import { fetchCatalog, installSidecar } from "@/src/lib/services-api.ts";
import { useNodeStore } from "@/src/store/useNodeStore.ts";

/** The artifact families that can carry an available update. */
export type UpdateKind =
	| "app"
	| "agent"
	| "engine"
	| "tool"
	| "voice"
	| "media"
	| "plugin"
	| "skill"
	| "mcp"
	| "model";

/** One artifact with a newer version available. `key` is globally unique. */
export interface AvailableUpdate {
	/** App updates carry the raw verdict so apply can hand off to the native updater. */
	appVerdict?: UpdateCheck;
	currentVersion: string | null;
	/** The id/name the apply endpoint expects (agent id, sidecar name, plugin id). */
	id: string;
	/** `${kind}:${id}` — stable across refetches, used as the React key + apply id. */
	key: string;
	kind: UpdateKind;
	latestVersion: string | null;
	/** Extra apply payload for models (needs both repo + filename to re-download). */
	model?: { repoId: string; file: string };
	name: string;
	/** Release notes / changelog, when the source provides them (app only today). */
	notes?: string | null;
}

// Match the owning Store sections' react-query keys so no duplicate fetch fires.
const APP_KEY = (url: string) => ["update", "check", url] as const;
const AGENT_CATALOG_KEY = (url: string) => ["agents", "catalog", url] as const;
const SIDECAR_CATALOG_KEY = (url: string) =>
	["catalog", "sidecars", url] as const;
const APPS_KEY = (url: string) => ["apps", "list", url] as const;
const PLUGINS_CATALOG_KEY = (url: string) =>
	["plugins", "catalog", "all", url] as const;
const MODEL_UPDATES_KEY = (url: string) => ["models", "updates", url] as const;
const SKILL_UPDATES_KEY = (url: string) => ["skills", "updates", url] as const;
const MCP_UPDATES_KEY = (url: string) => ["mcp", "updates", url] as const;

// Upstream version checks are cheap on Core (VersionCache) but still remote;
// keep them fresh for a minute so re-opening the popup is instant.
const UPDATES_STALE_MS = 60_000;

/** A catalog category maps to the update kind shown in the UI. */
function catalogKind(category: string): UpdateKind {
	switch (category) {
		case "provider":
			return "engine";
		case "voice":
			return "voice";
		case "media":
			return "media";
		case "agent":
			return "agent";
		default:
			return "tool";
	}
}

export interface UseAvailableUpdatesResult {
	/** Keys currently being applied (for per-row spinners). */
	applyingKeys: Set<string>;
	/** Apply one update; resolves when the update action completes. */
	applyUpdate: (update: AvailableUpdate) => Promise<void>;
	/** True while the first fetch of any source is in flight. */
	loading: boolean;
	/** Re-run every source's check. */
	refresh: () => void;
	updates: AvailableUpdate[];
}

export function useAvailableUpdates(): UseAvailableUpdatesResult {
	const getNode = useNodeStore((s) => s.getActiveNode);
	const node = getNode();
	const target: ApiTarget = toTarget(node);
	const url = node.url;
	const token = node.token ?? null;
	const qc = useQueryClient();

	const results = useQueries({
		queries: [
			{
				queryKey: APP_KEY(url),
				queryFn: () => checkForUpdate(target),
				staleTime: UPDATES_STALE_MS,
			},
			{
				queryKey: AGENT_CATALOG_KEY(url),
				queryFn: () => fetchAgentCatalog(target),
				staleTime: UPDATES_STALE_MS,
			},
			{
				queryKey: SIDECAR_CATALOG_KEY(url),
				queryFn: () => fetchCatalog(url, token),
				staleTime: UPDATES_STALE_MS,
			},
			{
				queryKey: APPS_KEY(url),
				queryFn: () => fetchApps(target),
				staleTime: UPDATES_STALE_MS,
			},
			{
				queryKey: PLUGINS_CATALOG_KEY(url),
				queryFn: () => fetchAppsCatalog(target),
				staleTime: UPDATES_STALE_MS,
			},
			{
				queryKey: MODEL_UPDATES_KEY(url),
				queryFn: () => listModelUpdates(target),
				staleTime: UPDATES_STALE_MS,
			},
			{
				queryKey: SKILL_UPDATES_KEY(url),
				queryFn: () => listSkillUpdates(target),
				staleTime: UPDATES_STALE_MS,
			},
			{
				queryKey: MCP_UPDATES_KEY(url),
				queryFn: () => listMcpUpdates(target),
				staleTime: UPDATES_STALE_MS,
			},
		],
	});

	const [appQ, agentQ, catalogQ, appsQ, pluginCatalogQ, modelQ, skillQ, mcpQ] =
		results;

	const updates: AvailableUpdate[] = [];

	// App release train (core/gateway/cli/desktop bundled at one version).
	const appVerdict = appQ.data;
	if (appVerdict?.update_available) {
		updates.push({
			key: "app:ryu",
			kind: "app",
			id: "ryu",
			name: "Ryu app",
			currentVersion: appVerdict.current || null,
			latestVersion: appVerdict.latest || null,
			notes: appVerdict.notes,
			appVerdict,
		});
	}

	// Agents (npm/npx registry agents) — behind_latest on the agent or its bridge.
	for (const entry of agentQ.data ?? []) {
		const behind =
			entry.versionStatus === "behind_latest" ||
			entry.bridgeVersionStatus === "behind_latest";
		if (entry.added && behind) {
			updates.push({
				key: `agent:${entry.id}`,
				kind: "agent",
				id: entry.id,
				name: entry.name,
				currentVersion: entry.installedVersion ?? null,
				latestVersion: entry.latestVersion ?? null,
			});
		}
	}

	// Engines / tools / voice / media — installed and trailing the catalog latest.
	for (const item of catalogQ.data ?? []) {
		// Agent-category sidecars (e.g. zeroclaw/openclaw) are updated through the
		// agents catalog source above (runAgentUpdate), not the sidecar reinstall
		// path — skip them here so their apply hits the right endpoint and they
		// don't collide keys with the agents source.
		if (item.category === "agent") {
			continue;
		}
		const hasUpdate =
			item.installState === "installed" &&
			!item.deprecated &&
			item.installedVersion != null &&
			item.latestVersion != null &&
			item.installedVersion !== item.latestVersion;
		if (hasUpdate) {
			updates.push({
				key: `${catalogKind(item.category)}:${item.name}`,
				kind: catalogKind(item.category),
				id: item.name,
				name: item.displayName,
				currentVersion: item.installedVersion,
				latestVersion: item.latestVersion,
			});
		}
	}

	// Plugins — join installed apps (installedVersion) with the catalog (version).
	const installedById = new Map((appsQ.data ?? []).map((a) => [a.id, a]));
	for (const entry of pluginCatalogQ.data ?? []) {
		const installed = installedById.get(entry.id);
		if (
			installed?.installed &&
			installed.installedVersion &&
			entry.version &&
			installed.installedVersion !== entry.version
		) {
			updates.push({
				key: `plugin:${entry.id}`,
				kind: "plugin",
				id: entry.id,
				name: entry.name,
				currentVersion: installed.installedVersion,
				latestVersion: entry.version,
			});
		}
	}

	// Models — an installed GGUF whose on-disk file size trails the Hub's current
	// upload (Core computes this; see /api/models/updates). Apply re-downloads the
	// file through the download center.
	for (const entry of modelQ.data ?? []) {
		updates.push({
			key: `model:${entry.stem}`,
			kind: "model",
			id: entry.stem,
			name: entry.name || entry.repoId,
			currentVersion: null,
			latestVersion: null,
			model: { repoId: entry.repoId, file: entry.filename },
		});
	}

	// Skills — installed skill whose local SKILL.md differs from upstream. Apply
	// re-installs the package (overwrites SKILL.md).
	for (const entry of skillQ.data ?? []) {
		updates.push({
			key: `skill:${entry.slug}`,
			kind: "skill",
			id: entry.id,
			name: entry.name,
			currentVersion: null,
			latestVersion: null,
		});
	}

	// MCP — installed catalog server whose recorded version trails the registry.
	// Apply force-reinstalls the server (preserving enabled state + env).
	for (const entry of mcpQ.data ?? []) {
		updates.push({
			key: `mcp:${entry.name}`,
			kind: "mcp",
			id: entry.catalogId,
			name: entry.name,
			currentVersion: entry.currentVersion,
			latestVersion: entry.latestVersion,
		});
	}

	const applyMutation = useMutation({
		mutationKey: ["available-updates", "apply", url],
		mutationFn: async (update: AvailableUpdate): Promise<void> => {
			switch (update.kind) {
				case "app": {
					if (update.appVerdict) {
						await installUpdate(update.appVerdict);
					}
					return;
				}
				case "agent": {
					await runAgentUpdate(target, update.id);
					return;
				}
				case "plugin": {
					await updateInstalledPlugin(target, update.id);
					return;
				}
				// engine/tool/voice/media all reinstall via the sidecar setup path,
				// which re-downloads the latest through the download center.
				case "engine":
				case "tool":
				case "voice":
				case "media": {
					await installSidecar(url, token, update.id);
					return;
				}
				case "model": {
					if (update.model) {
						// Re-download the newer file through the verified downloader.
						await installModelFile(
							target,
							update.model.repoId,
							update.model.file
						);
					}
					return;
				}
				case "skill": {
					// Re-install the package; overwrites the local SKILL.md.
					await installSkill(target, update.id);
					return;
				}
				case "mcp": {
					// Force-reinstall (overwrite) at the newer catalog version.
					await installMcpServer(target, update.id, true);
					return;
				}
				default:
					throw new Error(`Updating ${update.kind} is not supported yet`);
			}
		},
		onSettled: (_data, _err, update) => {
			// Revalidate the source that owned this update so the row clears once
			// the new version is installed.
			const invalidate = (key: readonly unknown[]) =>
				Promise.resolve(qc.invalidateQueries({ queryKey: key })).catch(
					() => undefined
				);
			switch (update.kind) {
				case "app":
					invalidate(APP_KEY(url));
					break;
				case "agent":
					invalidate(AGENT_CATALOG_KEY(url));
					break;
				case "plugin":
					invalidate(APPS_KEY(url));
					invalidate(PLUGINS_CATALOG_KEY(url));
					break;
				case "model":
					invalidate(MODEL_UPDATES_KEY(url));
					break;
				case "skill":
					invalidate(SKILL_UPDATES_KEY(url));
					break;
				case "mcp":
					invalidate(MCP_UPDATES_KEY(url));
					break;
				default:
					invalidate(SIDECAR_CATALOG_KEY(url));
			}
		},
	});

	const applyUpdate = useCallback(
		(update: AvailableUpdate) => applyMutation.mutateAsync(update),
		[applyMutation]
	);

	const refresh = useCallback(() => {
		for (const q of [
			APP_KEY,
			AGENT_CATALOG_KEY,
			SIDECAR_CATALOG_KEY,
			APPS_KEY,
			PLUGINS_CATALOG_KEY,
			MODEL_UPDATES_KEY,
			SKILL_UPDATES_KEY,
			MCP_UPDATES_KEY,
		]) {
			Promise.resolve(qc.invalidateQueries({ queryKey: q(url) })).catch(
				() => undefined
			);
		}
	}, [qc, url]);

	// react-query's mutation state exposes the vars of in-flight mutations; track
	// the keys being applied so each row can show its own spinner.
	const applyingKeys = new Set<string>();
	if (applyMutation.isPending && applyMutation.variables) {
		applyingKeys.add(applyMutation.variables.key);
	}

	return {
		updates,
		loading: results.some((r) => r.isLoading),
		applyingKeys,
		refresh,
		applyUpdate,
	};
}
