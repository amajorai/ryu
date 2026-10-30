import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { useEffect, useState } from "react";
import { AgentModelPickerField } from "@/components/agent-elements/input/agent-model-picker-field.tsx";
import { AgentSelectionField } from "@/components/agent-elements/input/agent-selection-field.tsx";
import {
	type AgentSelection,
	EMPTY_AGENT_SELECTION,
	getAgentSelection,
	setAgentSelection,
} from "@/src/lib/api/preferences.ts";
import {
	type FieldControlProps,
	saveField,
} from "./PluginSettingsFields-save-field.ts";
import { SettingsItem } from "./shared/settings-items.tsx";

export function ModelPickerField({
	field,
	target,
	storedPreference,
}: FieldControlProps) {
	const tl = useLiteralMessages();
	const [value, setValue] = useState(storedPreference ?? "");

	const commit = (next: string) => {
		const previous = value;
		setValue(next);
		void saveField(target, field.prefKey, next.trim()).then((ok) => {
			if (!ok) {
				setValue(previous);
			}
		});
	};

	// The SAME provider/model picker the chat composer uses (brand logos +
	// per-provider model lists), controlled — replaces the old free-text box so a
	// plugin's "which model runs this" is a precise catalog pick, not a typo-prone
	// string.
	return (
		<SettingsItem title={field.label}>
			<div className="flex items-center gap-2">
				<div className="min-w-0 flex-1">
					<AgentModelPickerField
						ariaLabel={field.label}
						mode="model"
						onChange={commit}
						placeholder={field.placeholder ?? "Use default model"}
						target={target}
						value={value}
					/>
				</div>
				{value ? (
					<Button
						aria-label={tl("Use default for {label}", { label: field.label })}
						onClick={() => commit("")}
						size="sm"
						type="button"
						variant="ghost"
					>
						Use default
					</Button>
				) : null}
			</div>
		</SettingsItem>
	);
}

export function AgentPickerField({ field, target }: FieldControlProps) {
	const [value, setValue] = useState<AgentSelection>(EMPTY_AGENT_SELECTION);

	useEffect(() => {
		let cancelled = false;
		getAgentSelection(target, field.prefKey).then((stored) => {
			if (!cancelled) {
				setValue(stored);
			}
		});
		return () => {
			cancelled = true;
		};
	}, [target, field.prefKey]);

	// The FULL composer target — agent, provider, model, thinking, effort, access
	// mode — persisted as one selection. A plugin that can be served by an agent
	// (not only a raw model call) declares this instead of `model_picker`; left
	// unset, it inherits the node-wide default from the Gateway dialog.
	const commit = (next: AgentSelection) => {
		const previous = value;
		setValue(next);
		setAgentSelection(target, field.prefKey, next)
			.then((ok) => {
				if (!ok) {
					setValue(previous);
					toast.error({
						title: "Couldn't save this setting",
						description: "Check your connection and try again.",
					});
				}
			})
			.catch(() => {
				setValue(previous);
				toast.error({
					title: "Couldn't save this setting",
					description: "Check your connection and try again.",
				});
			});
	};

	return (
		<SettingsItem title={field.label}>
			<AgentSelectionField
				ariaLabel={field.label}
				onChange={commit}
				placeholder={field.placeholder ?? "Use the default"}
				target={target}
				value={value}
			/>
		</SettingsItem>
	);
}
