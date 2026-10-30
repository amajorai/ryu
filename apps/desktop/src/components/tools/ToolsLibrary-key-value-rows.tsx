import { Delete01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import type { ChangeEvent } from "react";

export interface McpKeyValueRow {
	key: string;
	value: string;
}

export function McpKeyValueRows({
	label,
	onChange,
	onRemove,
	rows,
	secret,
}: {
	label: string;
	onChange: (index: number, field: keyof McpKeyValueRow, value: string) => void;
	onRemove: (index: number) => void;
	rows: McpKeyValueRow[];
	secret?: boolean;
}) {
	const tl = useLiteralMessages();
	return (
		<div className="flex flex-col gap-2">
			<Label variant="choice">{label}</Label>
			{rows.map((row, index) => (
				<div className="flex items-center gap-2" key={`${row.key}-${index}`}>
					<Input
						aria-label={tl("{label} key {index}", {
							label,
							index: String(index + 1),
						})}
						onChange={(event: ChangeEvent<HTMLInputElement>) =>
							onChange(index, "key", event.target.value)
						}
						placeholder="Key"
						value={row.key}
					/>
					<Input
						aria-label={tl("{label} value {index}", {
							label,
							index: String(index + 1),
						})}
						onChange={(event: ChangeEvent<HTMLInputElement>) =>
							onChange(index, "value", event.target.value)
						}
						placeholder={
							secret && row.value === "••••••" ? "Leave unchanged" : "Value"
						}
						type={secret ? "password" : "text"}
						value={row.value}
					/>
					<Button
						aria-label={tl("Remove {label} {index}", {
							label: label.toLowerCase(),
							index: String(index + 1),
						})}
						onClick={() => onRemove(index)}
						size="icon-sm"
						variant="ghost"
					>
						<HugeiconsIcon className="size-4" icon={Delete01Icon} />
					</Button>
				</div>
			))}
		</div>
	);
}
