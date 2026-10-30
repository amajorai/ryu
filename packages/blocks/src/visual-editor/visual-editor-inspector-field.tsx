import { Input, Label, Textarea } from "@ryu/blocks/companion/controls";
import { useState } from "react";

export function InspectorField({
	defaultValue,
	disabled,
	label,
	multiline = false,
	onCommit,
}: {
	defaultValue: string;
	disabled: boolean;
	label: string;
	multiline?: boolean;
	onCommit: (value: string) => void;
}) {
	const [value, setValue] = useState(defaultValue);
	const id = `visual-field-${label.toLowerCase().replace(/\W+/g, "-")}`;
	const commit = () => {
		if (value !== defaultValue) {
			onCommit(value);
		}
	};
	return (
		<div className="flex flex-col gap-1">
			<Label htmlFor={id} size="compact">
				{label}
			</Label>
			{multiline ? (
				<Textarea
					className="min-h-16"
					disabled={disabled}
					id={id}
					onBlur={commit}
					onChange={(event) => setValue(event.target.value)}
					value={value}
				/>
			) : (
				<Input
					className="h-8"
					disabled={disabled}
					id={id}
					onBlur={commit}
					onChange={(event) => setValue(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Enter") {
							event.preventDefault();
							commit();
						}
					}}
					value={value}
				/>
			)}
		</div>
	);
}
