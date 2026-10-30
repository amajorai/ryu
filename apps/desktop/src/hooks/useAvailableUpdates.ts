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

import { useLiteralMessages } from "@ryu/i18n/react";
import { useMutation, useQueries, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { sileo } from "sileo";
import { applyReleaseUpdate } from "@/src/components/updater/AutoUpdater.tsx";
import {
	pluginHasUpdate,
	showsAppUpdateRow,
} from "@/src/hooks/available-updates-policy.ts";
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
import { checkForUpdate, updateCheckFailed } from "@/src/lib/api/update.ts";
import { getAppVersion } from "@/src/lib/app-version.ts";
import { fetchCatalog, installSidecar } from "@/src/lib/services-api.ts";
import { isLocalNode, useNodeStore } from "@/src/store/useNodeStore.ts";
import {
	AGENT_CATALOG_KEY,
	APP_KEY,
	APP_VERSION_KEY,
	APPS_KEY,
	catalogKind,
	MCP_UPDATES_KEY,
	MODEL_UPDATES_KEY,
	PLUGINS_CATALOG_KEY,
	SIDECAR_CATALOG_KEY,
	SKILL_UPDATES_KEY,
	UPDATES_STALE_MS,
} from "./useAvailableUpdates-keys.ts";
import { invalidateAfterApply } from "./useAvailableUpdates-settle.ts";
import type {
	ApplyOutcome,
	AvailableUpdate,
	UseAvailableUpdatesResult,
} from "./useAvailableUpdates-types.ts";

export type {
	AvailableUpdate,
	UpdateKind,
	UseAvailableUpdatesResult,
} from "./useAvailableUpdates-types.ts";

export function useAvailableUpdates(): UseAvailableUpdatesResult {
	const getNode = useNodeStore((s) => s.getActiveNode);
	const node = getNode();
	const target: ApiTarget = useMemo(
		() => toTarget(node),
		[node.token, node.url, node.userJwt]
	);
	const url = node.url;
	const token = node.token ?? null;
	const qc = useQueryClient();
	const tl = useLiteralMessages();

	const queries = useMemo(
		() =>
			[
				{
					queryKey: APP_KEY(url),
					// Throw on a FAILED check (rate limit, network) instead of accepting
					// the fail-open sentinel: react-query then keeps the last good
					// verdict, so an available-update row doesn't silently vanish the
					// moment one background re-check hits GitHub's rate limit.
					queryFn: async () => {
						const verdict = await checkForUpdate(target);
						if (updateCheckFailed(verdict)) {
							throw new Error(verdict.error ?? "update check failed");
						}
						return verdict;
					},
					staleTime: UPDATES_STALE_MS,
				},
				{
					queryKey: AGENT_CATALOG_KEY(url),
					queryFn: () => fetchAgentCatalog(target),
					staleTime: UPDATES_STALE_MS,
				},
				{
					queryKey: SIDECAR_CATALOG_KEY(url),
					queryFn: () => fetchCatalog(url, token, undefined, target.userJwt),
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
				{
					// Not node-scoped and it cannot change while the app runs, so it is
					// keyed globally and never refetched.
					queryKey: APP_VERSION_KEY,
					queryFn: () => getAppVersion(),
					staleTime: Number.POSITIVE_INFINITY,
				},
			] as const,
		[target, url, token]
	);
	const results = useQueries({ queries });

	const [
		appQ,
		agentQ,
		catalogQ,
		appsQ,
		pluginCatalogQ,
		modelQ,
		skillQ,
		mcpQ,
		appVersionQ,
	] = results;

	const updates: AvailableUpdate[] = [];

	// App release train (core/gateway/cli/desktop bundled at one version).
	//
	// Gated on the APP's own version, not on `verdict.current`. Core answers about
	// ITSELF, and on macOS `ryu-core` is a separately-downloaded binary under
	// `~/.ryu/bin` — one left behind at an older version made this row a permanent
	// "Ryu app 0.0.14 → 0.1.3" that could never clear: its apply reaches
	// `installUpdate`, the Tauri updater correctly finds nothing newer than the
	// running 0.1.3 bundle, and the user gets a manual-download toast instead.
	//
	// That gate is LOCAL-only. A remote node updates itself through
	// `POST /api/update/apply`, so its own verdict is the truth there: a remote
	// Core on 0.1.0 viewed from an app already on 0.1.3 still needs the update.
	const appVerdict = appQ.data;
	if (
		appVerdict &&
		showsAppUpdateRow(appVerdict, isLocalNode(node), appVersionQ.data)
	) {
		updates.push({
			key: "app:ryu",
			kind: "app",
			id: "ryu",
			name: "Ryu app",
			currentVersion: appVersionQ.data ?? appVerdict.current ?? null,
			latestVersion: appVerdict.latest || null,
			notes: appVerdict.notes,
			appVerdict,
		});
	}

	// Agents (npm/npx registry agents) — behind_latest on the agent CLI.
	//
	// Deliberately NOT on the bridge. An ACP bridge is spawned as `npx -y <pkg>@latest`,
	// so npx re-resolves it on every launch: it is never a thing the user can be
	// behind on, and there is no action that would clear such a row. Its "installed"
	// side is itself a `@latest` probe, so the pair measures nothing but the skew
	// between that live resolve and Core's cached npm latest — which produced a row
	// with no version text (the text comes from the CLI pair, null here) that no
	// press of Update could ever remove.
	for (const entry of agentQ.data ?? []) {
		if (entry.added && entry.versionStatus === "behind_latest") {
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
		// The NODE decides. Comparing installedVersion to latestVersion here was
		// the bug behind "I press Update and nothing happens": engines whose
		// downloader pins its version at compile time can never reach the upstream
		// tag the catalog advertised, so the row was permanent and its Update
		// press hit an already-installed fast path that returned 200 having done
		// nothing.
		if (item.updateAvailable) {
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
	//
	// Semver, within the installed build's channel. A plain `!==` offered
	// downgrades (a stale catalog) and cross-channel "updates" — a plugin on a
	// beta train against the stable catalog version — that Core's channel-scoped
	// apply resolves to a no-op, so the row could never clear.
	const installedById = new Map((appsQ.data ?? []).map((a) => [a.id, a]));
	for (const entry of pluginCatalogQ.data ?? []) {
		const installed = installedById.get(entry.id);
		if (
			installed?.installed &&
			pluginHasUpdate(installed.installedVersion, entry.version)
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
			slug: entry.slug,
			currentVersion: null,
			latestVersion: null,
			source: entry.source,
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
			source: entry.source ?? undefined,
		});
	}

	const applyMutation = useMutation({
		mutationKey: ["available-updates", "apply", url],
		mutationFn: async (update: AvailableUpdate): Promise<ApplyOutcome> => {
			switch (update.kind) {
				case "app": {
					if (!update.appVerdict?.update_available) {
						return { detail: "Already on the latest release.", silent: false };
					}
					// Which updater is correct depends on whether this node is the one
					// the app is bundled with — `applyReleaseUpdate` owns that call.
					// A null message means the native updater took over and is already
					// reporting its own progress.
					const message = await applyReleaseUpdate(
						target,
						node,
						update.appVerdict
					);
					return { detail: message, silent: message === null };
				}
				case "agent": {
					const res = await runAgentUpdate(target, update.id);
					if (res.error) {
						throw new Error(res.error);
					}
					if (!res.updated) {
						// Core distinguishes "nothing to do" from "not mine to update".
						// Reporting the latter as up-to-date is what made the row look
						// stuck: the version never moved and the toast said it had.
						return {
							detail:
								res.hint ??
								tl("{name} is already up to date.", { name: update.name }),
							silent: false,
						};
					}
					return {
						detail: res.installedVersion
							? tl("{name} updated to {installedVersion}.", {
									name: update.name,
									installedVersion: res.installedVersion,
								})
							: `${update.name} updated.`,
						silent: false,
					};
				}
				case "plugin": {
					const res = await updateInstalledPlugin(target, update.id);
					return {
						detail: res.version
							? tl("{name} updated to {version}.", {
									name: update.name,
									version: res.version,
								})
							: `${update.name} updated.`,
						silent: false,
					};
				}
				// engine/tool/voice/media all reinstall through the sidecar setup path.
				// `force` is what makes it an UPDATE rather than a no-op: Core drops the
				// recorded version/checksum so its installer's already-installed fast
				// path misses and the artifact is genuinely re-downloaded.
				case "engine":
				case "tool":
				case "voice":
				case "media": {
					await installSidecar(
						url,
						token,
						update.id,
						true,
						undefined,
						target.userJwt
					);
					// Core installs in the background and streams bytes through the
					// download center, so this resolves at the START of the work.
					return {
						detail: tl("Downloading {name} — progress is in Downloads.", {
							name: update.name,
						}),
						silent: false,
					};
				}
				case "model": {
					if (!update.model) {
						throw new Error(
							`No source file recorded for ${update.name}, so it cannot be re-downloaded.`
						);
					}
					await installModelFile(
						target,
						update.model.repoId,
						update.model.file
					);
					return {
						detail: tl("Downloading {name} — progress is in Downloads.", {
							name: update.name,
						}),
						silent: false,
					};
				}
				case "skill": {
					// Apply on the source that found the update, not the active one.
					await installSkill(target, update.id, update.source);
					return { detail: `${update.name} updated.`, silent: false };
				}
				case "mcp": {
					// Apply on the registry the check ran against, not the active one.
					await installMcpServer(target, update.id, true, update.source);
					return { detail: `${update.name} updated.`, silent: false };
				}
				default:
					throw new Error(`Updating ${update.kind} is not supported yet`);
			}
		},
		// Every outcome is reported. Silence was the whole complaint: a successful
		// apply looked identical to a failed one and to a no-op, because the only
		// signal was a row that may or may not clear on the next refetch.
		onSuccess: (outcome, update) => {
			if (outcome.silent) {
				return;
			}
			sileo.success({
				title: `Updating ${update.name}`,
				description: outcome.detail ?? undefined,
				duration: 4000,
			});
		},
		onError: (err, update) => {
			sileo.error({
				title: tl("Couldn't update {name}", { name: update.name }),
				description: err instanceof Error ? err.message : String(err),
				duration: null,
			});
		},
		onSettled: (_data, _err, update) => {
			invalidateAfterApply(qc, url, update);
		},
	});

	const applyUpdate = useCallback(
		async (update: AvailableUpdate) => {
			await applyMutation.mutateAsync(update);
		},
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
