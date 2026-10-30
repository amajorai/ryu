import { Input } from "@ryu/ui/components/input.tsx";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import { Textarea } from "@ryu/ui/components/textarea.tsx";
import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import { useState } from "react";
import { prefToBool } from "@/src/lib/pluginSettings.ts";
import {
	type FieldControlProps,
	saveField,
} from "./PluginSettingsFields-save-field.ts";
import { SettingsItem } from "./shared/settings-items.tsx";

export function ToggleField({
	field,
	target,
	storedPreference,
}: FieldControlProps) {
	const defaultOn = field.default === true;
	const [checked, setChecked] = useState(
		prefToBool(storedPreference ?? null, defaultOn)
	);

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

export function SelectField({
	field,
	target,
	storedPreference,
}: FieldControlProps) {
	const fallback = isNativeText(field.default) ? field.default : "";
	const [value, setValue] = useState(storedPreference ?? fallback);

	return (
		<SettingsItem title={field.label}>
			<Select
				items={field.options}
				onValueChange={async (raw) => {
					// Base UI's Select emits `null` when the selection is cleared;
					// preferences store bare strings, so that reads as "unset".
					const next = raw ?? "";
					const previous = value;
					setValue(next);
					const ok = await saveField(target, field.prefKey, next);
					if (!ok) {
						setValue(previous);
					}
				}}
				value={value}
			>
				<SelectTrigger aria-label={field.label} className="h-8 w-full">
					<SelectValue placeholder="Select…" />
				</SelectTrigger>
				<SelectContent>
					{field.options.map((opt) => (
						<SelectItem key={opt.value} value={opt.value}>
							{opt.label}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
		</SettingsItem>
	);
}

export function TextField({
	bare,
	description,
	field,
	target,
	storedPreference,
}: FieldControlProps) {
	const fallback =
		field.default === undefined || field.default === null
			? ""
			: String(field.default);
	const [value, setValue] = useState(storedPreference ?? fallback);
	const isTextarea = field.type === "textarea";

	const save = () => {
		saveField(target, field.prefKey, value.trim()).catch(() => {
			// saveField already surfaces failures via toast.
		});
	};

	return (
		// A `textarea` field is a tall bordered box; inside the group's card fill it
		// reads as a box in a box, so those rows go `bare` while the single-line
		// `text` fields stay ordinary rows. Driven by the declared field type at the
		// call site, so every plugin that declares a textarea gets the same
		// treatment without touching this file again.
		// `description` is forwarded, not dropped: the group only renders a caption
		// for a CARDED row, so a bare one has to render its own.
		<SettingsItem bare={bare} description={description} title={field.label}>
			{isTextarea ? (
				<Textarea
					aria-label={field.label}
					className="min-h-24"
					onBlur={save}
					onChange={(e) => setValue(e.target.value)}
					placeholder={field.placeholder}
					typography="small"
					value={value}
				/>
			) : (
				<Input
					aria-label={field.label}
					onBlur={save}
					onChange={(e) => setValue(e.target.value)}
					placeholder={field.placeholder}
					size="settings-search"
					type="text"
					value={value}
				/>
			)}
		</SettingsItem>
	);
}
