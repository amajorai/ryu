"use client";

import { ArrowDown01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@ryu/ui/components/popover";
import { cn } from "@ryu/ui/lib/utils";
import { memo, useCallback, useState } from "react";
import {
	COMPOSER_SELECT_ITEM,
	COMPOSER_SELECT_POPOVER,
	COMPOSER_SELECT_TRIGGER,
} from "@/components/agent-elements/input/composer-select.ts";
import {
	type AcpConfigOption,
	type AcpSessionModeState,
	flattenConfigOptions,
} from "@/src/lib/api/acp.ts";

interface SelectItem {
	description?: string | null;
	id: string;
	name: string;
}

/**
 * The shared composer dropdown backing every ACP session-control picker
 * (permission mode, reasoning effort, …). Identical look to the model picker:
 * a muted ghost trigger showing the active item, a top-opening popover of
 * options with the active one checked, and an optional description aside.
 */
const SelectMenu = memo(function SelectMenu({
	items,
	value,
	onChange,
	ariaLabel,
	leadingLabel,
	className,
}: {
	items: SelectItem[];
	value: string | undefined;
	onChange: (id: string) => void;
	ariaLabel: string;
	/** Small muted prefix shown before the active name (e.g. "Mode"). */
	leadingLabel?: string;
	className?: string;
}) {
	const [open, setOpen] = useState(false);
	const active = items.find((it) => it.id === value) ?? items[0];

	const handleSelect = useCallback(
		(id: string) => {
			onChange(id);
			setOpen(false);
		},
		[onChange]
	);

	if (items.length === 0) {
		return null;
	}

	return (
		<Popover onOpenChange={setOpen} open={open}>
			<PopoverTrigger
				render={
					<Button
						aria-label={ariaLabel}
						className={cn(COMPOSER_SELECT_TRIGGER, className)}
						size="sm"
						type="button"
						variant="ghost"
					/>
				}
			>
				{leadingLabel && (
					<span className="font-normal text-muted-foreground/70">
						{leadingLabel}
					</span>
				)}
				<span className="font-medium">{active?.name ?? ariaLabel}</span>
				<HugeiconsIcon
					className="text-muted-foreground"
					icon={ArrowDown01Icon}
					size={12}
				/>
			</PopoverTrigger>
			<PopoverContent
				align="start"
				className={COMPOSER_SELECT_POPOVER}
				side="top"
				sideOffset={6}
			>
				{items.map((item) => {
					const isActive = item.id === active?.id;
					return (
						<Button
							className={cn(
								COMPOSER_SELECT_ITEM,
								"flex-col items-start gap-0.5",
								isActive && "bg-accent"
							)}
							key={item.id}
							onClick={() => handleSelect(item.id)}
							type="button"
							variant="ghost"
						>
							<span className="flex w-full items-center gap-2.5">
								<span className="flex-1 truncate">{item.name}</span>
								{isActive && (
									<HugeiconsIcon
										className="shrink-0 text-muted-foreground"
										icon={Tick02Icon}
										size={16}
										strokeWidth={2}
									/>
								)}
							</span>
							{item.description && (
								<span className="w-full truncate text-left font-normal text-muted-foreground text-xs">
									{item.description}
								</span>
							)}
						</Button>
					);
				})}
			</PopoverContent>
		</Popover>
	);
});

export interface PermissionModePickerProps {
	className?: string;
	modes: AcpSessionModeState;
	onChange: (modeId: string) => void;
	/** Selected mode id; falls back to the agent's `currentModeId`. */
	value?: string;
}

/**
 * Per-agent permission-mode picker (Zed-style). The mode list — default /
 * acceptEdits / plan / bypassPermissions / read-only, etc. — is exactly what the
 * agent advertises at `session/new`; Ryu hardcodes none of it. Switching applies
 * on the next turn (Core re-applies it via `session/set_mode`).
 */
export const PermissionModePicker = memo(function PermissionModePicker({
	modes,
	value,
	onChange,
	className,
}: PermissionModePickerProps) {
	const items: SelectItem[] = modes.availableModes.map((m) => ({
		id: m.id,
		name: m.name,
		description: m.description,
	}));
	return (
		<SelectMenu
			ariaLabel="Permission mode"
			className={className}
			items={items}
			onChange={onChange}
			value={value ?? modes.currentModeId}
		/>
	);
});

export interface AcpOptionPickerProps {
	className?: string;
	onChange: (valueId: string) => void;
	option: AcpConfigOption;
	/** Selected value id; falls back to the option's `currentValue`. */
	value?: string;
}

/**
 * Clean a select option's display label: strip a redundant "<OptionName>: "
 * prefix (Pi reports "Thinking: off", "Thinking: low", … for its `thought_level`
 * option) and capitalize the first letter, so the composer trigger reads "Off",
 * not "Thinking: off".
 */
function formatOptionLabel(optionName: string, valueName: string): string {
	let label = valueName.trim();
	const prefix = `${optionName.trim()}:`;
	if (label.toLowerCase().startsWith(prefix.toLowerCase())) {
		label = label.slice(prefix.length).trim();
	}
	return label.length > 0
		? label.charAt(0).toUpperCase() + label.slice(1)
		: label;
}

/**
 * A single agent-reported `select` config option (e.g. reasoning effort /
 * `thoughtLevel`). Only `select` options render; anything else is skipped.
 */
export const AcpOptionPicker = memo(function AcpOptionPicker({
	option,
	value,
	onChange,
	className,
}: AcpOptionPickerProps) {
	if (option.type && option.type !== "select") {
		return null;
	}
	const items: SelectItem[] = flattenConfigOptions(option).map((o) => ({
		id: o.value,
		name: formatOptionLabel(option.name, o.name),
		description: o.description,
	}));
	if (items.length === 0) {
		return null;
	}
	return (
		<SelectMenu
			ariaLabel={option.name}
			className={className}
			items={items}
			onChange={onChange}
			value={value ?? option.currentValue}
		/>
	);
});
