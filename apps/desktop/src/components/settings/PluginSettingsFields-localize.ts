// apps/desktop/src/components/settings/PluginSettingsFields-localize.ts
//
// A plugin's settings tab copy (tab title, field labels, descriptions,
// placeholders and option labels) comes from its manifest in English. This
// maps one tab through the active locale's catalog before the fields render,
// so every control, `aria-label` and caption reads the translated copy.

import type { LiteralMessage } from "@ryu/i18n/react";
import { manifestCopy, optionalManifestCopy } from "@/src/lib/manifest-copy.ts";
import type {
	PluginSettingsField,
	PluginSettingsTab,
} from "@/src/lib/pluginSettings.ts";

function localizeField(
	tl: LiteralMessage,
	field: PluginSettingsField
): PluginSettingsField {
	return {
		...field,
		description: optionalManifestCopy(tl, field.description),
		label: manifestCopy(tl, field.label),
		options: field.options.map((option) => ({
			...option,
			label: manifestCopy(tl, option.label),
		})),
		placeholder: optionalManifestCopy(tl, field.placeholder),
	};
}

/** One settings tab with its manifest copy in the active locale. */
export function localizeSettingsTab(
	tl: LiteralMessage,
	tab: PluginSettingsTab
): PluginSettingsTab {
	return {
		...tab,
		fields: tab.fields.map((field) => localizeField(tl, field)),
		title: manifestCopy(tl, tab.title),
	};
}
