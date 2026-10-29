"use client";

// Small presentational controls shared by every guardrail editor: the lock
// toggle a base scope uses to freeze a field, the read-only marker a narrower
// scope sees for a frozen field, and the Inherit / On / Off selector.

import { SquareLock01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Badge } from "@ryu/ui/components/badge";
import { Button } from "@ryu/ui/components/button";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip";

/** Lock or unlock a lockable field (base scope only). */
export function LockToggle({
	locked,
	disabled,
	fieldLabel,
	onToggle,
}: {
	disabled: boolean;
	fieldLabel: string;
	locked: boolean;
	onToggle: () => void;
}) {
	const tl = useLiteralMessages();
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<Button
						aria-label={
							locked
								? tl("Unlock {fieldLabel} field", { fieldLabel })
								: tl("Lock {fieldLabel} field", { fieldLabel })
						}
						aria-pressed={locked}
						disabled={disabled}
						onClick={onToggle}
						size="icon-sm"
						variant={locked ? "secondary" : "ghost"}
					>
						<HugeiconsIcon
							className={locked ? "size-4" : "size-4 text-muted-foreground"}
							icon={SquareLock01Icon}
						/>
					</Button>
				}
			/>
			<TooltipContent>
				{locked
					? "Locked. Narrower scopes (org, agent) cannot loosen this field."
					: "Lock so narrower scopes cannot loosen this field."}
			</TooltipContent>
		</Tooltip>
	);
}

/** Read-only indicator shown when a broader scope froze a field. */
export function LockedByBroader({ summary }: { summary: string }) {
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<span className="flex items-center gap-1.5 text-muted-foreground text-sm">
						<HugeiconsIcon className="size-3.5" icon={SquareLock01Icon} />
						{summary}
					</span>
				}
			/>
			<TooltipContent>
				Locked by a broader scope. Change it there to unlock this field.
			</TooltipContent>
		</Tooltip>
	);
}

/** Map an overlay tri-state boolean to the select value. */
export function boolToTri(value: boolean | null | undefined): string {
	if (value === null || value === undefined) {
		return "inherit";
	}
	return value ? "on" : "off";
}

/** Map the select value back to the overlay tri-state boolean. */
export function triToBool(value: string | null): boolean | null {
	if (value === "on") {
		return true;
	}
	if (value === "off") {
		return false;
	}
	return null;
}

/**
 * Inherit / On / Off selector for an overlay boolean field. With `addOnly`
 * the Off option is gone: a named policy can turn a protection on, never off.
 */
export function TriStateBool({
	addOnly = false,
	ariaLabel,
	value,
	inheritedLabel,
	disabled,
	onChange,
	id,
}: {
	addOnly?: boolean;
	ariaLabel: string;
	disabled: boolean;
	id: string;
	/** Shown in parentheses after Inherit; omit when the value is not known. */
	inheritedLabel?: string;
	onChange: (next: boolean | null) => void;
	value: boolean | null | undefined;
}) {
	const items = [
		{
			value: "inherit",
			label: inheritedLabel ? `Inherit (${inheritedLabel})` : "Inherit",
		},
		{ value: "on", label: "On" },
		...(addOnly ? [] : [{ value: "off", label: "Off" }]),
	];
	return (
		<Select
			disabled={disabled}
			items={items}
			onValueChange={(next: string | null) => onChange(triToBool(next))}
			value={boolToTri(addOnly && value === false ? null : value)}
		>
			<SelectTrigger aria-label={ariaLabel} className="w-40" id={id}>
				<SelectValue />
			</SelectTrigger>
			<SelectContent>
				{items.map((item) => (
					<SelectItem key={item.value} value={item.value}>
						{item.label}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}

/** Marks a card whose stage the running gateway pipeline does not include. */
export function PipelineBadge({ active }: { active: boolean }) {
	return active ? null : (
		<Badge size="compact" variant="secondary">
			Not in pipeline
		</Badge>
	);
}
