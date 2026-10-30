import { toast } from "@ryu/ui/components/sileo.tsx";
import type { ReactNode } from "react";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import { setPreference } from "@/src/lib/api/preferences.ts";
import type { PluginSettingsField } from "@/src/lib/pluginSettings.ts";

export async function saveField(
	target: ApiTarget,
	prefKey: string,
	value: string
): Promise<boolean> {
	const showFailure = () => {
		// One options object, not (title, options): `toast.error` takes a single
		// argument (see @ryu/ui/components/sileo), so the two-argument spelling
		// type-errors and drops the description on the floor.
		toast.error({
			title: "Couldn't save this setting",
			description: "Check your connection and try again.",
		});
	};
	try {
		const ok = await setPreference(target, prefKey, value);
		if (!ok) {
			showFailure();
		}
		return ok;
	} catch {
		showFailure();
		return false;
	}
}

// ── Per-type field controls ─────────────────────────────────────────────────
export interface FieldControlProps {
	/**
	 * Render this field outside the group's card. Read off THIS element by the
	 * enclosing SettingsGroup — same opt-in as `description` — which is why the
	 * caller passes it rather than the leaf control setting it internally:
	 * `Children.toArray` only sees the wrapper's props, not the `SettingsItem`
	 * buried inside it.
	 */
	bare?: boolean;
	/**
	 * iOS-style footer caption for this field's card. The wrapper never renders
	 * it — the enclosing SettingsGroup reads it off this element and renders it
	 * below the card (see settings-items).
	 */
	description?: ReactNode;
	field: PluginSettingsField;
	/**
	 * The manifest id of the plugin that declared this field. Preference-backed
	 * controls don't need it (a `pref_key` is already node-global), but a `secret`
	 * field does: secrets are scoped per plugin at
	 * `/api/plugins/:id/secrets/:key`. Every tab carries one — `parseSettingsTabs`
	 * drops any entry without a plugin id — so this is always populated.
	 */
	pluginId: string;
	storedPreference?: string | null;
	target: ApiTarget;
}
