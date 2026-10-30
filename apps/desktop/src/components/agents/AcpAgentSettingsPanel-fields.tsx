// apps/desktop/src/components/agents/AcpAgentSettingsPanel-fields.tsx
//
// Form rows shared by AcpAgentSettingsPanel.

import { Input } from "@ryu/ui/components/input.tsx";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import { Textarea } from "@ryu/ui/components/textarea.tsx";
import { useId } from "react";
import { SettingsItem } from "@/src/components/settings/shared/settings-items.tsx";
import type { Choice } from "./AcpAgentSettingsPanel-draft.ts";

export function TextRow({
	description,
	label,
	multiline,
	onChange,
	placeholder,
	value,
	disabled,
}: {
	description: string;
	disabled: boolean;
	label: string;
	multiline?: boolean;
	onChange: (value: string) => void;
	placeholder?: string;
	value: string;
}) {
	const id = useId();
	return (
		<SettingsItem
			description={description}
			title={<label htmlFor={id}>{label}</label>}
		>
			{multiline ? (
				<Textarea
					disabled={disabled}
					id={id}
					onChange={(event) => onChange(event.target.value)}
					placeholder={placeholder}
					rows={3}
					spellCheck={false}
					value={value}
					variant="code-caption"
				/>
			) : (
				<Input
					disabled={disabled}
					id={id}
					onChange={(event) => onChange(event.target.value)}
					placeholder={placeholder}
					spellCheck={false}
					value={value}
					variant="code-caption"
				/>
			)}
		</SettingsItem>
	);
}

export function ChoiceSelect({
	ariaLabel,
	choices,
	disabled,
	onChange,
	value,
}: {
	ariaLabel: string;
	choices: Choice[];
	disabled: boolean;
	onChange: (value: string) => void;
	value: string;
}) {
	return (
		<NativeSelect
			aria-label={ariaLabel}
			disabled={disabled}
			onChange={(event) => onChange(event.target.value)}
			value={value}
		>
			<NativeSelectOption value="">Agent default</NativeSelectOption>
			{choices.map((choice) => (
				<NativeSelectOption key={choice.id} value={choice.id}>
					{choice.name}
				</NativeSelectOption>
			))}
		</NativeSelect>
	);
}
