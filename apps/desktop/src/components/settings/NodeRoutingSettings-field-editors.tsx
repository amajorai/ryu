import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { useState } from "react";
import {
	numericText,
	PERCENTILES,
	type Percentile,
	type PercentileValues,
} from "./NodeRoutingSettings-options.ts";
import { SettingsItem } from "./shared/settings-items.tsx";

export function ModelFallbackEditor({
	values,
	onChange,
	disabled,
}: {
	values: string[];
	onChange: (values: string[]) => void;
	disabled: boolean;
}) {
	const tl = useLiteralMessages();
	const [candidate, setCandidate] = useState("");
	const add = () => {
		const model = candidate.trim();
		if (model && !values.includes(model)) {
			onChange([...values, model]);
		}
		setCandidate("");
	};
	return (
		<div className="space-y-2">
			<div className="flex min-w-0 gap-2">
				<Input
					aria-label="OpenRouter fallback model id"
					autoComplete="off"
					className="min-w-0"
					disabled={disabled}
					onChange={(event) => setCandidate(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Enter") {
							event.preventDefault();
							add();
						}
					}}
					placeholder="e.g. anthropic/claude-sonnet-4.6"
					value={candidate}
				/>
				<Button
					disabled={disabled || !candidate.trim()}
					onClick={add}
					size="sm"
				>
					Add model
				</Button>
			</div>
			{values.length > 0 ? (
				<ol className="divide-y divide-border/60">
					{values.map((model, index) => (
						<li
							className="flex flex-wrap items-center justify-between gap-2 py-1.5"
							key={`${model}-${index}`}
						>
							<span className="text-sm">
								<span className="mr-2 text-muted-foreground">{index + 1}.</span>
								<code>{model}</code>
							</span>
							<Button
								aria-label={tl("Remove fallback model {model}", { model })}
								disabled={disabled}
								onClick={() =>
									onChange(values.filter((item) => item !== model))
								}
								size="sm"
								variant="ghost"
							>
								Remove
							</Button>
						</li>
					))}
				</ol>
			) : null}
		</div>
	);
}

export function PercentileEditor({
	keyName,
	label,
	unit,
	values,
	onChange,
	disabled,
}: {
	keyName: "preferred_min_throughput" | "preferred_max_latency";
	label: string;
	unit: string;
	values: PercentileValues;
	onChange: (
		key: "preferred_min_throughput" | "preferred_max_latency",
		percentile: Percentile,
		raw: string
	) => void;
	disabled: boolean;
}) {
	return (
		<SettingsItem
			title={
				<>
					{label}
					<span className="text-muted-foreground">{unit}</span>
				</>
			}
		>
			<div className="grid grid-cols-2 gap-3 pb-1 sm:grid-cols-4">
				{PERCENTILES.map((percentile) => (
					<label className="space-y-1 text-xs" key={percentile}>
						<span className="text-muted-foreground">{percentile}</span>
						<Input
							aria-label={`${label} ${percentile}`}
							disabled={disabled}
							min={0}
							onChange={(event) =>
								onChange(keyName, percentile, event.target.value)
							}
							placeholder="No preference"
							step="any"
							type="number"
							value={numericText(values[percentile])}
						/>
					</label>
				))}
			</div>
		</SettingsItem>
	);
}

/** One per-unit price cap, as a settings row (title left, field right). */
export function PriceInput({
	label,
	value,
	onChange,
	disabled,
}: {
	label: string;
	value: string;
	onChange: (value: string) => void;
	disabled: boolean;
}) {
	return (
		<SettingsItem
			actions={
				<div>
					<Input
						aria-label={label}
						className="h-8 w-32"
						disabled={disabled}
						min={0}
						onChange={(event) => onChange(event.target.value)}
						placeholder="No cap"
						step="any"
						type="number"
						value={value}
					/>
				</div>
			}
			title={label}
		/>
	);
}
