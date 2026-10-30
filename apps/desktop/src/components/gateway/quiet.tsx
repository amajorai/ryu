// Small, quiet building blocks shared by the Gateway, inference, usage and
// billing panes: a status dot plus muted text (instead of a badge for a normal
// state), a flat stat tile and its 4-up grid (instead of stat cards), and an
// info tooltip that carries the mechanism detail a caption used to spell out.
// Nothing here is a new primitive; each is a thin arrangement of `@ryu/ui`.
import {
	ArrowDown01Icon,
	InformationCircleIcon,
	MoreHorizontalIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@ryu/ui/components/collapsible.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@ryu/ui/components/dropdown-menu.tsx";
import {
	ToggleGroup,
	ToggleGroupItem,
} from "@ryu/ui/components/toggle-group.tsx";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import type { ReactNode } from "react";

export type StatusTone =
	| "success"
	| "warning"
	| "destructive"
	| "info"
	| "muted";

const DOT_TONE: Record<StatusTone, string> = {
	success: "bg-status-success",
	warning: "bg-status-warning",
	destructive: "bg-status-destructive",
	info: "bg-status-info",
	muted: "bg-muted-foreground/70",
};

/** A 6px status dot in a status-colour token. */
export function StatusDot({
	className,
	tone,
}: {
	className?: string;
	tone: StatusTone;
}) {
	return (
		<span
			aria-hidden="true"
			className={cn(
				"size-1.5 shrink-0 rounded-full",
				DOT_TONE[tone],
				className
			)}
		/>
	);
}

/**
 * A status dot followed by muted `text-sm` text: the quiet replacement for a
 * badge that names a normal state (ok, enabled, trusted, present, pass).
 */
export function StatusText({
	children,
	className,
	tone,
}: {
	children: ReactNode;
	className?: string;
	tone: StatusTone;
}) {
	return (
		<span
			className={cn(
				"inline-flex min-w-0 items-center gap-1.5 text-muted-foreground text-sm",
				className
			)}
		>
			<StatusDot tone={tone} />
			<span className="truncate">{children}</span>
		</span>
	);
}

/** One flat stat: a `text-detail` muted label over a `text-xl` tabular value. */
export function StatTile({
	className,
	detail,
	label,
	value,
}: {
	className?: string;
	detail?: ReactNode;
	label: ReactNode;
	value: ReactNode;
}) {
	return (
		<div className={cn("min-w-0", className)}>
			<p className="text-(length:--text-detail) truncate text-muted-foreground leading-(--text-detail--line-height)">
				{label}
			</p>
			<p className="mt-1 truncate font-medium text-xl tabular-nums">{value}</p>
			{detail ? (
				<p className="mt-0.5 truncate text-muted-foreground text-xs">
					{detail}
				</p>
			) : null}
		</div>
	);
}

/** The 4-up (2-up when narrow) grid for {@link StatTile}s, with no card. */
export function StatGrid({
	children,
	className,
}: {
	children: ReactNode;
	className?: string;
}) {
	return (
		<div
			className={cn(
				"grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4",
				className
			)}
		>
			{children}
		</div>
	);
}

/** A muted (i) that opens a tooltip with the detail a caption used to repeat. */
export function InfoHint({
	children,
	label,
}: {
	children: ReactNode;
	label: string;
}) {
	return (
		<Tooltip>
			<TooltipTrigger
				aria-label={label}
				className="inline-flex size-4 shrink-0 items-center justify-center rounded-full align-[-3px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
				type="button"
			>
				<HugeiconsIcon
					aria-hidden="true"
					className="size-3.5"
					icon={InformationCircleIcon}
				/>
			</TooltipTrigger>
			<TooltipContent className="max-w-80 whitespace-normal">
				{children}
			</TooltipContent>
		</Tooltip>
	);
}

export interface OverflowMenuItem {
	destructive?: boolean;
	disabled?: boolean;
	id: string;
	label: ReactNode;
	onSelect: () => void;
}

/**
 * A ghost `icon-sm` ⋯ button that opens a menu: where secondary row and
 * section actions live so only one action stays visible.
 */
export function OverflowMenu({
	className,
	items,
	label = "More actions",
}: {
	className?: string;
	items: OverflowMenuItem[];
	label?: string;
}) {
	if (items.length === 0) {
		return null;
	}
	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				render={
					<Button
						aria-label={label}
						className={className}
						// Nothing to offer (every action disabled): the trigger says so.
						disabled={items.every((item) => item.disabled)}
						size="icon-sm"
						variant="ghost"
					>
						<HugeiconsIcon className="size-4" icon={MoreHorizontalIcon} />
					</Button>
				}
			/>
			<DropdownMenuContent align="end">
				{items.map((item) => (
					<DropdownMenuItem
						className={item.destructive ? "text-status-destructive" : undefined}
						disabled={item.disabled}
						key={item.id}
						onClick={item.onSelect}
					>
						{item.label}
					</DropdownMenuItem>
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

/**
 * A one-line caption with its mechanism detail one hover away, so a section
 * never carries a paragraph of helper text.
 */
export function CaptionInfo({
	children,
	detail,
}: {
	children: ReactNode;
	detail: ReactNode;
}) {
	return (
		<>
			{children} <InfoHint label="More about this">{detail}</InfoHint>
		</>
	);
}

/**
 * A quiet "Show details" disclosure: a muted text trigger with a chevron, and
 * the secondary content below it once opened. Closed by default.
 */
export function Disclosure({
	children,
	className,
	defaultOpen = false,
	label = "Show details",
}: {
	children: ReactNode;
	className?: string;
	defaultOpen?: boolean;
	label?: ReactNode;
}) {
	return (
		<Collapsible className={className} defaultOpen={defaultOpen}>
			<CollapsibleTrigger className="group/disclosure inline-flex h-8 items-center gap-1.5 rounded-lg text-muted-foreground text-sm outline-none transition-colors duration-150 hover:text-foreground hover:duration-0 focus-visible:ring-2 focus-visible:ring-ring">
				{label}
				<HugeiconsIcon
					aria-hidden="true"
					className="size-3.5 transition-transform duration-(--duration-fast) ease-move group-data-[panel-open]/disclosure:rotate-180"
					icon={ArrowDown01Icon}
				/>
			</CollapsibleTrigger>
			<CollapsibleContent className="pt-2">{children}</CollapsibleContent>
		</Collapsible>
	);
}

/**
 * A segmented control for a one-of choice. Items stay `aria-pressed`
 * buttons (not tabs), so a choice keeps its button role and accessible name.
 */
export function Segmented<TValue extends string>({
	className,
	disabled,
	label,
	onChange,
	options,
	value,
}: {
	className?: string;
	disabled?: boolean;
	label: string;
	onChange: (value: TValue) => void;
	options: readonly { label: string; value: TValue }[];
	value: TValue;
}) {
	return (
		<ToggleGroup
			appearance="segmented"
			aria-label={label}
			className={cn("h-auto max-w-full flex-wrap", className)}
			disabled={disabled}
			multiple={false}
			onValueChange={(values: string[]) => {
				const next = options.find((option) => option.value === values[0]);
				if (next) {
					onChange(next.value);
				}
			}}
			spacing={0}
			value={[value]}
			variant="default"
		>
			{options.map((option) => (
				<ToggleGroupItem
					density="segmented"
					key={option.value}
					value={option.value}
				>
					{option.label}
				</ToggleGroupItem>
			))}
		</ToggleGroup>
	);
}
