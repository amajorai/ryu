// apps/desktop/src/components/settings/PluginSettingsFields.tsx
//
// Renders a plugin's declared settings fields as editable controls, each bound
// to Core's generic preference store (`GET/PUT /api/preferences/:key`). This is
// the missing bridge: a plugin declares `contributes.settings_tabs` in its
// manifest, Core serves them via `/api/plugins/contributions`, and this maps each
// field `type` → a control + persists edits under the field's `pref_key`.
//
// It reuses the shared iOS-style settings primitives (SettingsSection / Group /
// Item) so plugin settings look identical to the Gateway cards and the built-in
// settings tabs — nothing bespoke. Field values persist as bare strings
// (booleans as "true"/"false"), matching the conventions in lib/api/preferences.
//
// Used by two surfaces: inline on the Store's installed plugin card (the
// per-plugin "Settings" disclosure) and the App Settings "Plugins" section.

import { Button } from "@ryu/ui/components/button.tsx";
import { useEffect, useMemo, useState } from "react";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import { getPreference } from "@/src/lib/api/preferences.ts";
import type { PluginSettingsTab } from "@/src/lib/pluginSettings.ts";
import {
	SelectField,
	TextField,
	ToggleField,
} from "./PluginSettingsFields-basic-fields.tsx";
import { NumberField } from "./PluginSettingsFields-number-field.tsx";
import {
	AgentPickerField,
	ModelPickerField,
} from "./PluginSettingsFields-picker-fields.tsx";
import type { FieldControlProps } from "./PluginSettingsFields-save-field.ts";
import { SecretField } from "./PluginSettingsFields-secret-field.tsx";
import {
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "./shared/settings-items.tsx";

function LoadedFieldControl(props: FieldControlProps) {
	switch (props.field.type) {
		case "toggle":
			return <ToggleField {...props} />;
		case "select":
			return props.field.options.length > 0 ? (
				<SelectField {...props} />
			) : (
				<TextField {...props} />
			);
		case "number":
			return <NumberField {...props} />;
		case "secret":
			return <SecretField {...props} />;
		case "model_picker":
			return <ModelPickerField {...props} />;
		case "agent_picker":
			return <AgentPickerField {...props} />;
		default:
			// text, textarea, and any unrecognized type render as text.
			return <TextField {...props} />;
	}
}

function FieldControl(props: FieldControlProps) {
	const { field, target } = props;
	const targetUrl = target.url;
	const targetToken = target.token;
	const targetUserJwt = target.userJwt ?? null;
	const preferenceBacked =
		field.type !== "secret" && field.type !== "agent_picker";
	const [loading, setLoading] = useState(preferenceBacked);
	const [failed, setFailed] = useState(false);
	const [storedPreference, setStoredPreference] = useState<string | null>(null);
	const [attempt, setAttempt] = useState(0);

	useEffect(() => {
		if (!preferenceBacked) {
			return;
		}
		let cancelled = false;
		setLoading(true);
		setFailed(false);
		getPreference(
			{ url: targetUrl, token: targetToken, userJwt: targetUserJwt },
			field.prefKey
		)
			.then((stored) => {
				if (!cancelled) {
					setStoredPreference(stored);
				}
			})
			.catch(() => {
				if (!cancelled) {
					setFailed(true);
				}
			})
			.finally(() => {
				if (!cancelled) {
					setLoading(false);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [
		targetUrl,
		targetToken,
		targetUserJwt,
		field.prefKey,
		preferenceBacked,
		attempt,
	]);

	if (preferenceBacked && (loading || failed)) {
		return (
			<SettingsItem title={field.label}>
				{failed ? (
					<div className="flex items-center gap-2">
						<span role="alert">Couldn't load this setting.</span>
						<Button
							onClick={() => setAttempt((value) => value + 1)}
							size="sm"
							variant="ghost"
						>
							Retry
						</Button>
					</div>
				) : (
					<span role="status">Loading…</span>
				)}
			</SettingsItem>
		);
	}
	return <LoadedFieldControl {...props} storedPreference={storedPreference} />;
}

// ── Tab + panel ─────────────────────────────────────────────────────────────

interface PluginSettingsFieldsProps {
	/** Hide each tab's title header (used inline where the plugin name is already shown). */
	hideTabTitles?: boolean;
	tabs: PluginSettingsTab[];
	target: ApiTarget;
}

/**
 * Footer caption for a picker field the plugin didn't describe itself. Both
 * picker types say the same load-bearing thing — blank inherits the node-wide
 * default set in the Gateway dialog, so "blank" is a real choice, not an
 * oversight.
 */
function defaultFieldDescription(type: string): string | undefined {
	if (type === "model_picker") {
		return "Any model the Gateway can route. Leave blank to use the node's default.";
	}
	if (type === "agent_picker") {
		return "An agent, or a provider and model. Leave blank to use the node's default.";
	}
	if (type === "secret") {
		return "Stored on this node and never shown again. Enter a new value to replace it.";
	}
	return undefined;
}

/**
 * Render one plugin's settings tabs. Each tab becomes a {@link SettingsSection}
 * with a grouped card of its fields.
 */
export function PluginSettingsFields({
	hideTabTitles,
	tabs,
	target,
}: PluginSettingsFieldsProps) {
	const targetUrl = target.url;
	const targetToken = target.token;
	const targetUserJwt = target.userJwt ?? null;
	// Callers may reconstruct ApiTarget during unrelated parent renders. Keep
	// reads and write-only metadata tied to its identity, not its object reference.
	const stableTarget = useMemo(
		() => ({ url: targetUrl, token: targetToken, userJwt: targetUserJwt }),
		[targetUrl, targetToken, targetUserJwt]
	);
	return (
		<div className="space-y-4">
			{tabs.map((tab) => (
				<SettingsSection
					key={tab.id}
					title={hideTabTitles ? undefined : tab.title}
				>
					<SettingsGroup>
						{tab.fields.map((field) => (
							<FieldControl
								bare={field.type === "textarea"}
								description={
									field.description ?? defaultFieldDescription(field.type)
								}
								field={field}
								key={`${target.url}:${tab.plugin}:${field.prefKey}`}
								pluginId={tab.plugin}
								target={stableTarget}
							/>
						))}
					</SettingsGroup>
				</SettingsSection>
			))}
		</div>
	);
}
