import { Button } from "@ryu/ui/components/button.tsx";
import { Kbd } from "@ryu/ui/components/kbd.tsx";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip.tsx";
import { cn } from "@ryu/ui/lib/utils";
import type { InterfaceGroup } from "@ryuhq/protocol/interfaces";
import type { ReactNode } from "react";
import type { MailStatusChip } from "./mail-model.ts";

/** Round icon button with a tooltip naming it (and its shortcut, if any). */
export function MailIconButton({
	children,
	className,
	disabled = false,
	label,
	onClick,
	shortcut,
	side = "bottom",
}: {
	children: ReactNode;
	className?: string;
	disabled?: boolean;
	label: string;
	onClick?: () => void;
	shortcut?: string;
	side?: "bottom" | "left" | "right" | "top";
}) {
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<Button
						aria-keyshortcuts={shortcut}
						aria-label={label}
						className={cn("rounded-full", className)}
						disabled={disabled}
						onClick={onClick}
						size="icon"
						variant="ghost-muted"
					/>
				}
			>
				{children}
			</TooltipTrigger>
			<TooltipContent side={side}>
				{label}
				{shortcut ? <Kbd>{shortcut}</Kbd> : null}
			</TooltipContent>
		</Tooltip>
	);
}

/**
 * Gmail's label chip: a small squared tag in front of the subject. Labels are
 * neutral; only a system state (a live run, a failed run) takes a tone.
 */
export function MailLabelChip({
	className,
	label,
}: {
	className?: string;
	label: InterfaceGroup;
}) {
	return (
		<span
			className={cn(
				"inline-flex h-5 max-w-36 shrink-0 items-center truncate rounded bg-foreground/8 px-1.5 font-normal text-foreground/80 text-xs leading-5",
				className
			)}
			data-label-id={label.id}
		>
			<span className="truncate">{label.name}</span>
		</span>
	);
}

export function MailStatusTag({
	chip,
	className,
}: {
	chip: MailStatusChip;
	className?: string;
}) {
	return (
		<span
			className={cn(
				"inline-flex h-5 shrink-0 items-center gap-1 rounded px-1.5 font-medium text-xs leading-5",
				chip.tone === "success"
					? "bg-success/12 text-status-success"
					: "bg-destructive/10 text-status-destructive",
				className
			)}
			data-status-chip={chip.tone}
		>
			{chip.tone === "success" ? (
				<span
					aria-hidden="true"
					className="size-1.5 rounded-full bg-current motion-safe:animate-pulse"
				/>
			) : null}
			{chip.label}
		</span>
	);
}
