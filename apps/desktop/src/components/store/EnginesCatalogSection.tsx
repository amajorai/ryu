// apps/desktop/src/components/store/EnginesCatalogSection.tsx
//
// The unified Engines section in the Store. One tab, grouped by modality:
// Text and Embedding · Image · Speech · Sandboxes. Each group lists that
// modality's local engines (the catalog's `provider` / `media` / `voice`
// categories) — NOT models.
//
// Uses the shared Store master-detail layout (left list, right preview) like
// Plugins, Models, MCP, and Skills.
//
// Two interaction models:
//   - Text (chat) engines are mutually exclusive — exactly one is the resident
//     engine, so the toggle SWAPS the active engine (re-points the gateway).
//   - Image / Speech engines run *alongside* Chat, so their toggle is
//     a plain start/stop of the engine's sidecar process.

import { EnginesErrorState } from "@ryu/blocks/desktop/store-engines.tsx";
import StoreCatalogLayout from "@ryu/marketplace/catalog/chrome/store-catalog-layout";
import { useMemo, useState } from "react";
import { useDebouncedValue } from "@/src/hooks/use-debounced-value.ts";
import { useEngines } from "@/src/hooks/useEngines.ts";
import { useOrgFeatures } from "@/src/hooks/useOrgFeatures.ts";
import { usePluginSettingsOpener } from "@/src/hooks/usePluginSettingsOpener.ts";
import { useSandboxBackends } from "@/src/hooks/useSandboxBackends.ts";
import {
	useVoiceEngines,
	type VoiceEngineEntry,
} from "@/src/hooks/useVoiceEngines.ts";
import { EngineDetailPanel } from "./EnginesCatalogSection-detail.tsx";
import { EngineList } from "./EnginesCatalogSection-list.tsx";
import {
	type EngineListItem,
	hasEngineUpdate,
	RUN_ALONGSIDE_CATEGORIES,
	SEARCH_DEBOUNCE_MS,
	sandboxDescription,
	unsupportedReason,
} from "./EnginesCatalogSection-model.ts";
import { useRowStates } from "./EnginesCatalogSection-row-states.ts";

export default function EnginesCatalogSection({
	selectedEngineId,
	onCloseEngine,
}: {
	selectedEngineId?: string;
	onCloseEngine?: () => void;
} = {}) {
	// Some engines ship as installed plugins with their own settings (a voice
	// backend, a sandbox provider); the resolver returns null for the rest.
	const settingsOpener = usePluginSettingsOpener();
	const [query, setQuery] = useState("");
	const debouncedQuery = useDebouncedValue(query, SEARCH_DEBOUNCE_MS);
	const [localSelectedId, setSelectedId] = useState<string | null>(null);
	const selectedId = selectedEngineId ?? localSelectedId;
	const { rowState, patchRow, runAction } = useRowStates();

	const {
		engines: textEngines,
		loading: textLoading,
		error: textError,
		install: installText,
		uninstall: uninstallText,
		activate: activateText,
		restart: restartText,
		reload: reloadText,
	} = useEngines();
	const { isEnabled: orgFeatureEnabled } = useOrgFeatures();
	const engineUpdatesAllowed = orgFeatureEnabled("engines.update");

	const {
		engines: voiceEngines,
		loading: voiceLoading,
		error: voiceError,
		install: installVoice,
		uninstall: uninstallVoice,
		reload: reloadVoice,
		setRunning: setVoiceRunning,
	} = useVoiceEngines(RUN_ALONGSIDE_CATEGORIES);

	const {
		backends: sandboxBackends,
		loading: sandboxLoading,
		error: sandboxError,
		reload: reloadSandbox,
		select: selectSandbox,
	} = useSandboxBackends();

	const loading = textLoading || voiceLoading || sandboxLoading;
	const error = textError ?? voiceError ?? sandboxError;

	const groups = useMemo(() => {
		const q = debouncedQuery.trim().toLowerCase();
		const matches = (displayName: string, description: string) =>
			!q ||
			displayName.toLowerCase().includes(q) ||
			description.toLowerCase().includes(q);

		const textItems: EngineListItem[] = textEngines
			.filter((e) => matches(e.displayName, e.description))
			.map((e) => ({
				id: `text:${e.name}`,
				kind: "text" as const,
				name: e.name,
				displayName: e.displayName,
				description: e.description,
				status: e.active ? ({ kind: "active" } as const) : null,
				installState: e.installState,
				installed: e.installState === "installed",
				available: e.supported,
				...(e.supported
					? {}
					: {
							unavailableReason: unsupportedReason(
								e.platforms,
								e.unsupportedReason
							),
						}),
				hasUpdate: engineUpdatesAllowed && hasEngineUpdate(e),
				toggled: e.active,
				// The resident engine can't be removed out from under the node.
				canUninstall: e.installState === "installed" && !e.active,
			}));

		const runAlongside = (
			e: VoiceEngineEntry,
			kind: "media" | "voice"
		): EngineListItem => ({
			id: `${kind}:${e.name}`,
			kind,
			name: e.name,
			displayName: e.displayName,
			description: e.description,
			status:
				e.runningKnown && e.running
					? ({ kind: "active", label: "Running" } as const)
					: null,
			installState: e.installState,
			installed: e.installState === "installed",
			// The node's verdict (OS + arch); Core also refuses to start it.
			available: e.supported,
			...(e.supported
				? {}
				: {
						unavailableReason: unsupportedReason(
							e.platforms,
							e.unsupportedReason
						),
					}),
			hasUpdate: engineUpdatesAllowed && hasEngineUpdate(e),
			toggled: e.running,
			toggleKnown: e.runningKnown,
			// Stop it before removing it, so a live sidecar is never pulled away.
			canUninstall:
				e.installState === "installed" && e.runningKnown && !e.running,
		});

		const mediaItems: EngineListItem[] = voiceEngines
			.filter((e) => e.category === "media")
			.filter((e) => matches(e.displayName, e.description))
			.map((e) => runAlongside(e, "media"));

		const voiceItems: EngineListItem[] = voiceEngines
			.filter((e) => e.category === "voice")
			.filter((e) => matches(e.displayName, e.description))
			.map((e) => runAlongside(e, "voice"));

		const sandboxItems: EngineListItem[] = sandboxBackends
			.filter((b) => matches(b.displayName, sandboxDescription(b)))
			.map((b) => ({
				id: `sandbox:${b.name}`,
				kind: "sandbox" as const,
				name: b.name,
				displayName: b.displayName,
				description: sandboxDescription(b),
				status: b.isDefault ? ({ kind: "default" } as const) : null,
				// Ryu never installs a sandbox backend — its runtime is detected on the
				// node — so the row carries no install lifecycle at all.
				installState: null,
				installed: b.detected,
				available: b.supported,
				hasUpdate: false,
				toggled: b.isDefault,
				canUninstall: false,
			}));

		return [
			{ kind: "text" as const, items: textItems },
			{ kind: "media" as const, items: mediaItems },
			{ kind: "voice" as const, items: voiceItems },
			{ kind: "sandbox" as const, items: sandboxItems },
		].filter((g) => g.items.length > 0);
	}, [
		textEngines,
		voiceEngines,
		sandboxBackends,
		debouncedQuery,
		engineUpdatesAllowed,
	]);

	// Card-level lifecycle, so an engine installs / starts / swaps straight from the
	// list — the same affordance Apps and Plugins cards have. Each dispatches on the
	// row's kind to the hook that owns it, and goes through `runAction` so the row's
	// pending + error state is the one the detail panel already shows.
	const handleInstall = (item: EngineListItem) => {
		runAction(item.name, "install", () =>
			item.kind === "text"
				? installText(item.name, item.hasUpdate)
				: installVoice(item.name, item.hasUpdate)
		);
	};

	const handleUninstall = (item: EngineListItem) => {
		runAction(item.name, "uninstall", () =>
			item.kind === "text"
				? uninstallText(item.name)
				: uninstallVoice(item.name)
		);
	};

	const handleToggle = (item: EngineListItem, next: boolean) => {
		runAction(item.name, "toggle", async () => {
			if (item.kind === "text") {
				const swap = await activateText(item.name);
				if (!swap.gatewayRefreshed) {
					patchRow(item.name, { gatewayStale: true });
				}
				return;
			}
			if (item.kind === "sandbox") {
				await selectSandbox(item.name);
				return;
			}
			await setVoiceRunning(item.name, next);
		});
	};

	if (error && groups.length === 0 && !loading) {
		return (
			<EnginesErrorState
				message={error}
				onRetry={() => {
					void Promise.all([reloadText(), reloadVoice(), reloadSandbox()]);
				}}
			/>
		);
	}

	const selectedName = selectedId?.split(":")[1] ?? null;

	return (
		<StoreCatalogLayout
			detail={
				<EngineDetailPanel
					activateText={activateText}
					installText={installText}
					installVoice={installVoice}
					patchRow={patchRow}
					restartText={restartText}
					rowState={rowState}
					runAction={runAction}
					sandboxBackends={sandboxBackends}
					sandboxError={sandboxError}
					sandboxLoading={sandboxLoading}
					selectedId={selectedId}
					selectSandbox={selectSandbox}
					setVoiceRunning={setVoiceRunning}
					textEngines={textEngines}
					textError={textError}
					textLoading={textLoading}
					uninstallText={uninstallText}
					uninstallVoice={uninstallVoice}
					voiceEngines={voiceEngines}
					voiceError={voiceError}
					voiceLoading={voiceLoading}
				/>
			}
			detailOnly={selectedEngineId !== undefined}
			detailTitle={selectedName ?? "Engine"}
			hasSelection={selectedId != null}
			list={
				<EngineList
					error={error}
					groups={groups}
					loading={loading}
					onClearSearch={() => setQuery("")}
					onInstall={handleInstall}
					onSelect={setSelectedId}
					onToggle={handleToggle}
					onUninstall={handleUninstall}
					rowState={rowState}
					selectedId={selectedId}
					settingsOpener={settingsOpener}
				/>
			}
			onCloseDetail={() => {
				setSelectedId(null);
				onCloseEngine?.();
			}}
			search={{
				value: query,
				onChange: setQuery,
				placeholder: "Search engines…",
			}}
		/>
	);
}

/** The same engine controls and lifecycle used by Store, hosted in Library. */
export function EngineDetailsDialog({
	engineId,
	onClose,
}: {
	engineId: string;
	onClose: () => void;
}) {
	return (
		<EnginesCatalogSection
			onCloseEngine={onClose}
			selectedEngineId={engineId}
		/>
	);
}
