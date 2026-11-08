// The value-type picker shared by the add form and the detail dialog. A sealed
// value offers only "Sealed", so the control is disabled once it is sealed.

import { Label } from "@ryu/ui/components/label.tsx";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select.tsx";
import {
	VALUE_TYPE_COPY,
	type VaultValueType,
	valueTypeChoices,
} from "./vault-value-type.ts";

interface VaultValueTypeSelectProps {
	/** The stored type, or `null` for a value that does not exist yet. */
	current: VaultValueType | null;
	disabled?: boolean;
	id: string;
	onChange: (type: VaultValueType) => void;
	value: VaultValueType;
}

export function VaultValueTypeSelect({
	current,
	disabled = false,
	id,
	onChange,
	value,
}: VaultValueTypeSelectProps) {
	const choices = valueTypeChoices(current);
	return (
		<div className="space-y-1.5" data-value-type={value}>
			<Label htmlFor={id}>Type</Label>
			<Select
				disabled={disabled || choices.length < 2}
				items={choices.map((type) => ({
					value: type,
					label: VALUE_TYPE_COPY[type].label,
				}))}
				onValueChange={(next) => {
					const picked = choices.find((type) => type === next);
					if (picked) {
						onChange(picked);
					}
				}}
				value={value}
			>
				<SelectTrigger id={id}>
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					{choices.map((type) => (
						<SelectItem key={type} value={type}>
							<div className="flex flex-col">
								<span>{VALUE_TYPE_COPY[type].label}</span>
								<span className="text-detail text-muted-foreground">
									{VALUE_TYPE_COPY[type].description}
								</span>
							</div>
						</SelectItem>
					))}
				</SelectContent>
			</Select>
			<p className="text-detail text-muted-foreground">
				{VALUE_TYPE_COPY[value].description}
			</p>
		</div>
	);
}
