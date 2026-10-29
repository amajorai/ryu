// apps/desktop/src/components/settings/EntitySettings.tsx
//
// Renders one app/plugin's settings entry (the body shown when its tab under the
// Apps / Plugins header is selected). An app registers its settings through its
// manifest `contributes.settings_tabs`; each tab is EITHER:
//   - declarative `fields` (bound to preference keys) → rendered generically by
//     PluginSettingsFields, no per-app code; or
//   - a `view` — a rich settings UI the app ships. First-party built-in apps
//     resolve it to a desktop component through SETTINGS_VIEWS below (the settings
//     analogue of the route table in `contributions/builtins.ts`). Third-party
//     apps declare an owned `companion` to mount their sandboxed settings UI.
//
// A `view` only resolves to a first-party component for a BUILT-IN app: a
// third-party app can't borrow the Memory/Meetings component by naming its key.

import { useLiteralMessages } from "@ryu/i18n/react";
import {
	Alert,
	AlertAction,
	AlertDescription,
	AlertTitle,
} from "@ryu/ui/components/alert.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { type ComponentType, useState } from "react";
import { useApps } from "@/src/hooks/useApps.ts";
import { usePluginContributions } from "@/src/hooks/usePluginContributions.ts";
import type { ScopedNavEntity } from "@/src/hooks/useScopedSettingsNav.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import { ISLAND_ENABLED } from "@/src/lib/island-availability.ts";
import { ownedCompanionId } from "@/src/lib/plugin-file-handlers.ts";
import type { PluginSettingsTab } from "@/src/lib/pluginSettings.ts";
import PluginCompanionPage from "@/src/pages/PluginCompanionPage.tsx";
import { DictationSettings } from "./DictationSettings.tsx";
import { IslandSettings } from "./IslandSettings.tsx";
import { LearningSettings } from "./LearningSettings.tsx";
import { McpSettingsPanel } from "./McpSettingsPanel.tsx";
import { MeetingsSettings } from "./MeetingsSettings.tsx";
import { MemoryTab } from "./MemoryTab.tsx";
import { PluginSettingsFields } from "./PluginSettingsFields.tsx";
import { PredictSettings } from "./PredictSettings.tsx";
import { QuestsSettings } from "./QuestsSettings.tsx";
import { ShadowSettings } from "./ShadowSettings.tsx";
import { SpacesSettings } from "./SpacesSettings.tsx";
import { SettingsSection } from "./shared/settings-items.tsx";

/**
 * Island's settings body while its release gate is off (see
 * `island-availability.ts`). An Island record installed before the gate keeps
 * its tab, but it explains the state instead of configuring a companion the
 * desktop never launches.
 */
function IslandUnavailable() {
	return (
		<Alert>
			<AlertTitle>Island isn't available in this release</AlertTitle>
			<AlertDescription>
				This desktop doesn't launch the Island companion, so there is nothing to
				configure yet. Its settings return here when Island ships.
			</AlertDescription>
		</Alert>
	);
}

/**
 * First-party settings views, keyed by the OWNING plugin id. Mirrors the
 * `path → component` table built-in routes use (`contributions/builtins.ts`). A
 * built-in app whose settings are a rich custom UI declares `{"view": "..."}` in
 * its manifest and is bound to its component here by its id.
 *
 * Keying on the plugin **id** (not the opaque `view` string) is the trust gate: a
 * third-party app can declare `"view": "meetings"` but its id isn't a key here, so
 * it can never borrow a first-party component. (`built_in` is NOT usable for this —
 * in Core it flags the 5 sidecar system apps only, not compiled-in first-party
 * apps.) A third-party `view` falls back to its declared `fields`; a sandboxed
 * settings UI for third-party apps uses an explicit owned `companion` reference.
 */
const SETTINGS_VIEWS = new Map<string, ComponentType>([
	["@ryu/island", ISLAND_ENABLED ? IslandSettings : IslandUnavailable],
	["@ryu/learning", LearningSettings],
	["@ryu/meetings", MeetingsSettings],
	["@ryu/memory", MemoryTab],
	["@ryu/quests", QuestsSettings],
	["@ryu/shadow", ShadowSettings],
	["@ryu/spaces", SpacesSettings],
	["@ryu/dictation", DictationSettings],
	["predict", PredictSettings],
]);

// These controls write node preferences only and remain necessary even when the
// owning app is off. Core's Learning capture path is not gated on the app record,
// so hiding its consent switches here would leave users unable to revoke them.
const CONSENT_VIEWS_AVAILABLE_WHILE_DISABLED = new Set(["@ryu/learning"]);

/** Resolve a tab's first-party settings component (bound to its owning plugin id). */
function firstPartyView(tab: PluginSettingsTab): ComponentType | null {
	if (!tab.view) {
		return null;
	}
	return SETTINGS_VIEWS.get(tab.plugin) ?? null;
}

/**
 * Banner shown when the owning app is installed but not enabled.
 *
 * Its settings are still editable — they are ordinary preferences, written
 * through the generic KV store, and configuring a plugin is usually what makes it
 * worth enabling (an API key being the standard case). What the user must not
 * conclude is that the plugin is running, so the state is stated outright and the
 * one action that changes it sits right here rather than back in the Store.
 */
function DisabledNotice({ entity }: { entity: ScopedNavEntity }) {
	const tl = useLiteralMessages();
	const { toggle, toggleError } = useApps();
	const [enabling, setEnabling] = useState(false);
	const description =
		entity.id === "@ryu/learning"
			? "The consent switches below are saved separately. You can change them whether the Learning app is on or off."
			: "You can set it up now. What you save here is kept and takes effect as soon as you turn it on.";

	const enable = () => {
		setEnabling(true);
		toggle(entity.id, true)
			.catch(() => {
				// `useApps` keeps the actionable failure in `toggleError`, which
				// remains visible below while the tab stays disabled.
			})
			.finally(() => setEnabling(false));
	};

	return (
		<Alert>
			<AlertTitle>
				{tl("{label} is turned off", { label: entity.label })}
			</AlertTitle>
			<AlertDescription>
				{description}
				{toggleError ? (
					<span className="mt-2 block text-status-destructive" role="alert">
						{toggleError}
					</span>
				) : null}
			</AlertDescription>
			<AlertAction>
				<Button disabled={enabling} onClick={enable} size="sm">
					{enabling ? "Turning on…" : "Turn on"}
				</Button>
			</AlertAction>
		</Alert>
	);
}

export function EntitySettings({
	entity,
	target,
}: {
	entity: ScopedNavEntity;
	target: ApiTarget;
}) {
	const { companions } = usePluginContributions();
	const companionTabs = entity.enabled
		? entity.tabs.filter(
				(tab) =>
					tab.companion &&
					ownedCompanionId(tab.companion, tab.plugin, companions)
			)
		: [];
	// Declarative-field tabs render together through the generic renderer; view
	// tabs each render their resolved component. Most apps have exactly one tab.
	const fieldTabs = entity.tabs.filter(
		(t) => !firstPartyView(t) && t.fields.length > 0
	);
	// Most rich views read routes behind their app's enabled gate and stay hidden
	// while that app is off. The Learning consent view is the narrow exception:
	// Core's capture path is not app-gated, so its opt-out controls must remain
	// reachable even when the Learning app record is disabled. Declarative fields
	// also remain available while off because they only read and write preferences.
	const viewTabs = entity.tabs.filter((tab) => {
		if (!firstPartyView(tab)) {
			return false;
		}
		return (
			entity.enabled || CONSENT_VIEWS_AVAILABLE_WHILE_DISABLED.has(tab.plugin)
		);
	});

	return (
		<div className="space-y-4">
			{entity.enabled ? null : <DisabledNotice entity={entity} />}
			{entity.enabled
				? entity.tabs.map((tab) =>
						tab.mcpSettings ? (
							<SettingsSection key={tab.id} title={tab.title}>
								<McpSettingsPanel
									plugin={tab.plugin}
									settings={tab.mcpSettings}
									target={target}
								/>
							</SettingsSection>
						) : null
					)
				: null}
			{companionTabs.map((tab) =>
				tab.companion ? (
					<SettingsSection key={tab.id} title={tab.title}>
						<div className="h-[min(36rem,70vh)] min-h-64">
							<PluginCompanionPage
								companionId={
									ownedCompanionId(tab.companion, tab.plugin, companions) ??
									tab.companion
								}
								mountContext={{
									surface: "settings",
									settingsTabId: tab.id,
								}}
							/>
						</div>
					</SettingsSection>
				) : null
			)}
			{viewTabs.map((tab) => {
				const View = firstPartyView(tab);
				if (!View) {
					return null;
				}
				return entity.tabs.length === 1 ? (
					<View key={tab.id} />
				) : (
					<SettingsSection key={tab.id} title={tab.title}>
						<View />
					</SettingsSection>
				);
			})}
			{fieldTabs.length > 0 ? (
				<PluginSettingsFields
					hideTabTitles={entity.tabs.length === 1}
					tabs={fieldTabs}
					target={target}
				/>
			) : null}
		</div>
	);
}
