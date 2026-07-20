import { Button } from "@ryu/ui/components/button";
import { Input } from "@ryu/ui/components/input";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@ryu/ui/components/popover";
import {
	getOptionColorClass,
	SELECT_OPTION_COLOR_KEYS,
} from "@ryu/ui/lib/data-grid";
import { cn } from "@ryu/ui/lib/utils";
import type { CellOpts } from "@ryu/ui/types/data-grid";
import { Plus, X } from "lucide-react";
import { useState } from "react";

/** The column types offered in the editor (file is deferred — needs uploads). */
const COLUMN_TYPE_OPTIONS: Array<{
	variant: CellOpts["variant"];
	label: string;
}> = [
	{ variant: "short-text", label: "Text" },
	{ variant: "long-text", label: "Long text" },
	{ variant: "number", label: "Number" },
	{ variant: "select", label: "Select" },
	{ variant: "multi-select", label: "Multi-select" },
	{ variant: "checkbox", label: "Checkbox" },
	{ variant: "date", label: "Date" },
	{ variant: "url", label: "URL" },
];

const OPTION_VARIANTS = new Set<CellOpts["variant"]>([
	"select",
	"multi-select",
]);

interface OptionDraft {
	color: string;
	label: string;
	value: string;
}

function newOptionValue(): string {
	return `opt_${crypto.randomUUID().slice(0, 8)}`;
}

function initialOptions(cell?: CellOpts): OptionDraft[] {
	if (cell && (cell.variant === "select" || cell.variant === "multi-select")) {
		return cell.options.map((option) => ({
			value: option.value,
			label: option.label,
			color: option.color ?? SELECT_OPTION_COLOR_KEYS[0] ?? "gray",
		}));
	}
	return [];
}

function draftToCell(
	variant: CellOpts["variant"],
	options: OptionDraft[]
): CellOpts {
	if (variant === "select" || variant === "multi-select") {
		return {
			variant,
			options: options
				.filter((option) => option.label.trim())
				.map((option) => ({
					value: option.value,
					label: option.label.trim(),
					color: option.color,
				})),
		};
	}
	if (variant === "number") {
		return { variant: "number" };
	}
	return { variant } as CellOpts;
}

/**
 * A Notion-style column (property) editor used for both creating and editing a
 * database column: name, type, and — for select / multi-select — a list of
 * options with colored tags. The parent renders this inside a `Dialog` and
 * persists the result via `addColumn` (create) or `updateColumn` (edit).
 */
export function ColumnEditor({
	initial,
	submitLabel,
	onSubmit,
	onCancel,
}: {
	initial?: { label: string; cell: CellOpts };
	submitLabel: string;
	onSubmit: (label: string, cell: CellOpts) => void;
	onCancel: () => void;
}) {
	const [label, setLabel] = useState(initial?.label ?? "");
	const [variant, setVariant] = useState<CellOpts["variant"]>(
		initial?.cell.variant ?? "short-text"
	);
	const [options, setOptions] = useState<OptionDraft[]>(() =>
		initialOptions(initial?.cell)
	);

	const addOption = () =>
		setOptions((prev) => [
			...prev,
			{
				value: newOptionValue(),
				label: `Option ${prev.length + 1}`,
				color:
					SELECT_OPTION_COLOR_KEYS[
						prev.length % SELECT_OPTION_COLOR_KEYS.length
					] ?? "gray",
			},
		]);

	const setOptionLabel = (value: string, next: string) =>
		setOptions((prev) =>
			prev.map((option) =>
				option.value === value ? { ...option, label: next } : option
			)
		);

	const setOptionColor = (value: string, color: string) =>
		setOptions((prev) =>
			prev.map((option) =>
				option.value === value ? { ...option, color } : option
			)
		);

	const removeOption = (value: string) =>
		setOptions((prev) => prev.filter((option) => option.value !== value));

	const submit = () =>
		onSubmit(label.trim() || "Untitled", draftToCell(variant, options));

	return (
		<div className="flex flex-col gap-4">
			<div className="flex flex-col gap-1.5">
				<span className="font-medium text-sm">Name</span>
				<Input
					autoFocus
					onChange={(e) => setLabel(e.target.value)}
					placeholder="Property name"
					value={label}
				/>
			</div>

			<div className="flex flex-col gap-1.5">
				<span className="font-medium text-sm">Type</span>
				<div className="grid grid-cols-2 gap-1">
					{COLUMN_TYPE_OPTIONS.map((type) => (
						<Button
							className="justify-start"
							key={type.variant}
							onClick={() => setVariant(type.variant)}
							size="sm"
							variant={variant === type.variant ? "secondary" : "ghost"}
						>
							{type.label}
						</Button>
					))}
				</div>
			</div>

			{OPTION_VARIANTS.has(variant) && (
				<div className="flex flex-col gap-1.5">
					<span className="font-medium text-sm">Options</span>
					<div className="flex flex-col gap-1">
						{options.map((option) => (
							<div className="flex items-center gap-1.5" key={option.value}>
								<Popover>
									<PopoverTrigger
										render={
											<button
												aria-label="Option color"
												className={cn(
													"size-6 shrink-0 rounded-md border",
													getOptionColorClass(option.color)
												)}
												type="button"
											/>
										}
									/>
									<PopoverContent align="start" className="w-auto gap-1 p-2">
										<div className="grid grid-cols-5 gap-1">
											{SELECT_OPTION_COLOR_KEYS.map((color) => (
												<button
													aria-label={color}
													className={cn(
														"size-6 rounded-md border",
														getOptionColorClass(color),
														option.color === color && "ring-2 ring-ring"
													)}
													key={color}
													onClick={() => setOptionColor(option.value, color)}
													type="button"
												/>
											))}
										</div>
									</PopoverContent>
								</Popover>
								<Input
									className="h-8"
									onChange={(e) => setOptionLabel(option.value, e.target.value)}
									placeholder="Option"
									value={option.label}
								/>
								<Button
									aria-label="Remove option"
									onClick={() => removeOption(option.value)}
									size="icon"
									variant="ghost"
								>
									<X className="size-4" />
								</Button>
							</div>
						))}
						<Button
							className="justify-start text-muted-foreground"
							onClick={addOption}
							size="sm"
							variant="ghost"
						>
							<Plus className="size-3.5" />
							Add option
						</Button>
					</div>
				</div>
			)}

			<div className="flex justify-end gap-2">
				<Button onClick={onCancel} size="sm" variant="ghost">
					Cancel
				</Button>
				<Button onClick={submit} size="sm">
					{submitLabel}
				</Button>
			</div>
		</div>
	);
}
