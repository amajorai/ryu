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
//     apps would resolve it to their sandboxed UI (future — see PluginHostPanel);
//     until then a third-party `view` falls back to whatever `fields` it declared.
//
// A `view` only resolves to a first-party component for a BUILT-IN app: a
// third-party app can't borrow the Memory/Meetings component by naming its key.

import type { ComponentType } from "react";
import type { ScopedNavEntity } from "@/src/hooks/useScopedSettingsNav.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import type { PluginSettingsTab } from "@/src/lib/pluginSettings.ts";
import { MeetingsSettings } from "./MeetingsSettings.tsx";
import { MemoryTab } from "./MemoryTab.tsx";
import { PluginSettingsFields } from "./PluginSettingsFields.tsx";
import { PredictSettings } from "./PredictSettings.tsx";
import { QuestsSettings } from "./QuestsSettings.tsx";
import { SettingsSection } from "./shared/settings-items.tsx";

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
 * settings UI for third-party apps can hang off this same seam later.
 */
const SETTINGS_VIEWS: Record<string, ComponentType> = {
	"com.ryu.meetings": MeetingsSettings,
	"com.ryu.memory": MemoryTab,
	"com.ryu.quests": QuestsSettings,
	predict: PredictSettings,
};

/** Resolve a tab's first-party settings component (bound to its owning plugin id). */
function firstPartyView(tab: PluginSettingsTab): ComponentType | null {
	if (!tab.view) {
		return null;
	}
	return SETTINGS_VIEWS[tab.plugin] ?? null;
}

export function EntitySettings({
	entity,
	target,
}: {
	entity: ScopedNavEntity;
	target: ApiTarget;
}) {
	// Declarative-field tabs render together through the generic renderer; view
	// tabs each render their resolved component. Most apps have exactly one tab.
	const fieldTabs = entity.tabs.filter(
		(t) => !firstPartyView(t) && t.fields.length > 0
	);
	const viewTabs = entity.tabs.filter((t) => firstPartyView(t));

	return (
		<div className="space-y-4">
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
