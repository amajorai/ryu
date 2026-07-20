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

import { Button } from "@ryu/ui/components/button";
import { Input } from "@ryu/ui/components/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select";
import { toast } from "@ryu/ui/components/sileo";
import { Switch } from "@ryu/ui/components/switch";
import { Textarea } from "@ryu/ui/components/textarea";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import { fetchPiCatalog } from "@/src/lib/api/pi-config.ts";
import { getPreference, setPreference } from "@/src/lib/api/preferences.ts";
import {
	type PluginSettingsField,
	type PluginSettingsTab,
	prefToBool,
} from "@/src/lib/pluginSettings.ts";
import {
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "./shared/settings-items.tsx";

const MAX_MODEL_SUGGESTIONS = 8;

async function saveField(
	target: ApiTarget,
	prefKey: string,
	value: string
): Promise<boolean> {
	const ok = await setPreference(target, prefKey, value);
	if (!ok) {
		toast.error("Couldn't save this setting", {
			description: "Check your connection and try again.",
		});
	}
	return ok;
}

// ── Per-type field controls ─────────────────────────────────────────────────

interface FieldControlProps {
	/**
	 * iOS-style footer caption for this field's card. The wrapper never renders
	 * it — the enclosing SettingsGroup reads it off this element and renders it
	 * below the card (see settings-items).
	 */
	description?: ReactNode;
	field: PluginSettingsField;
	modelSuggestions: string[];
	target: ApiTarget;
}

function ToggleField({ field, target }: FieldControlProps) {
	const [checked, setChecked] = useState(false);

	useEffect(() => {
		let cancelled = false;
		getPreference(target, field.prefKey).then((raw) => {
			if (!cancelled) {
				setChecked(prefToBool(raw));
			}
		});
		return () => {
			cancelled = true;
		};
	}, [target, field.prefKey]);

	return (
		<SettingsItem
			actions={
				<Switch
					aria-label={field.label}
					checked={checked}
					onCheckedChange={async (next) => {
						setChecked(next);
						const ok = await saveField(target, field.prefKey, String(next));
						if (!ok) {
							setChecked(!next);
						}
					}}
				/>
			}
			title={field.label}
		/>
	);
}

function SelectField({ field, target }: FieldControlProps) {
	const [value, setValue] = useState("");

	useEffect(() => {
		let cancelled = false;
		getPreference(target, field.prefKey).then((raw) => {
			if (!cancelled) {
				setValue(raw ?? "");
			}
		});
		return () => {
			cancelled = true;
		};
	}, [target, field.prefKey]);

	return (
		<SettingsItem title={field.label}>
			<Select
				items={field.options}
				onValueChange={async (next) => {
					const previous = value;
					setValue(next);
					const ok = await saveField(target, field.prefKey, next);
					if (!ok) {
						setValue(previous);
					}
				}}
				value={value}
			>
				<SelectTrigger className="h-8 w-full text-sm">
					<SelectValue placeholder="Select…" />
				</SelectTrigger>
				<SelectContent>
					{field.options.map((opt) => (
						<SelectItem className="text-sm" key={opt.value} value={opt.value}>
							{opt.label}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
		</SettingsItem>
	);
}

function TextField({ field, target }: FieldControlProps) {
	const [value, setValue] = useState("");
	const isTextarea = field.type === "textarea";

	useEffect(() => {
		let cancelled = false;
		getPreference(target, field.prefKey).then((raw) => {
			if (!cancelled) {
				setValue(raw ?? "");
			}
		});
		return () => {
			cancelled = true;
		};
	}, [target, field.prefKey]);

	const save = () => {
		saveField(target, field.prefKey, value.trim()).catch(() => {
			// saveField already surfaces failures via toast.
		});
	};

	return (
		<SettingsItem title={field.label}>
			{isTextarea ? (
				<Textarea
					className="min-h-24 text-sm"
					onBlur={save}
					onChange={(e) => setValue(e.target.value)}
					placeholder={field.placeholder}
					value={value}
				/>
			) : (
				<Input
					className="h-8 text-sm"
					onBlur={save}
					onChange={(e) => setValue(e.target.value)}
					placeholder={field.placeholder}
					type={field.type === "number" ? "number" : "text"}
					value={value}
				/>
			)}
		</SettingsItem>
	);
}

function ModelPickerField({
	field,
	modelSuggestions,
	target,
}: FieldControlProps) {
	const [value, setValue] = useState("");

	useEffect(() => {
		let cancelled = false;
		getPreference(target, field.prefKey).then((raw) => {
			if (!cancelled) {
				setValue(raw ?? "");
			}
		});
		return () => {
			cancelled = true;
		};
	}, [target, field.prefKey]);

	const commit = (next: string) => {
		setValue(next);
		saveField(target, field.prefKey, next.trim()).catch(() => {
			// saveField already surfaces failures via toast.
		});
	};

	return (
		<SettingsItem title={field.label}>
			<div className="space-y-2">
				<Input
					className="h-8 text-sm"
					onBlur={() => commit(value)}
					onChange={(e) => setValue(e.target.value)}
					placeholder={field.placeholder ?? "Use default model"}
					value={value}
				/>
				{modelSuggestions.length > 0 ? (
					<div className="flex flex-wrap gap-1">
						{modelSuggestions.map((model) => (
							<Button
								className="h-6 rounded-full px-2 text-xs"
								key={model}
								onClick={() => commit(model)}
								size="sm"
								type="button"
								variant={value === model ? "secondary" : "ghost"}
							>
								{model}
							</Button>
						))}
					</div>
				) : null}
			</div>
		</SettingsItem>
	);
}

function FieldControl(props: FieldControlProps) {
	switch (props.field.type) {
		case "toggle":
			return <ToggleField {...props} />;
		case "select":
			return props.field.options.length > 0 ? (
				<SelectField {...props} />
			) : (
				<TextField {...props} />
			);
		case "model_picker":
			return <ModelPickerField {...props} />;
		default:
			// text, textarea, number, and any unrecognized type render as text.
			return <TextField {...props} />;
	}
}

// ── Tab + panel ─────────────────────────────────────────────────────────────

/**
 * Load the model-id suggestions once (flattened from the Pi config catalog's
 * per-provider suggested models), so `model_picker` fields can offer quick
 * picks. Returns an empty list until the catalog resolves or if it fails — the
 * free-text input still works without it.
 */
function useModelSuggestions(target: ApiTarget, enabled: boolean): string[] {
	const [models, setModels] = useState<string[]>([]);

	useEffect(() => {
		if (!enabled) {
			return;
		}
		let cancelled = false;
		fetchPiCatalog(target)
			.then((catalog) => {
				if (cancelled) {
					return;
				}
				const flat = (catalog.providers ?? []).flatMap(
					(p) => p.suggestedModels ?? []
				);
				setModels([...new Set(flat)].slice(0, MAX_MODEL_SUGGESTIONS));
			})
			.catch(() => {
				// Suggestions are optional; the input works without them.
			});
		return () => {
			cancelled = true;
		};
	}, [target, enabled]);

	return models;
}

interface PluginSettingsFieldsProps {
	/** Hide each tab's title header (used inline where the plugin name is already shown). */
	hideTabTitles?: boolean;
	tabs: PluginSettingsTab[];
	target: ApiTarget;
}

/**
 * Render one plugin's settings tabs. Each tab becomes a {@link SettingsSection}
 * with a grouped card of its fields. Model suggestions are fetched once for the
 * whole panel if any field is a `model_picker`.
 */
export function PluginSettingsFields({
	hideTabTitles,
	tabs,
	target,
}: PluginSettingsFieldsProps) {
	const hasModelPicker = useMemo(
		() => tabs.some((t) => t.fields.some((f) => f.type === "model_picker")),
		[tabs]
	);
	const modelSuggestions = useModelSuggestions(target, hasModelPicker);

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
								description={
									field.type === "model_picker"
										? (field.description ??
											"Any model the Gateway can route. Leave blank to use the default.")
										: field.description
								}
								field={field}
								key={field.prefKey}
								modelSuggestions={modelSuggestions}
								target={target}
							/>
						))}
					</SettingsGroup>
				</SettingsSection>
			))}
		</div>
	);
}
