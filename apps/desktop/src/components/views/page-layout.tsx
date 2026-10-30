import { MoreHorizontalIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@ryu/ui/components/dropdown-menu.tsx";
import { PageHeader } from "@ryu/ui/components/page-header.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import type { ReactNode } from "react";

/** `reading` is the 768px column; `wide` fits tables and grids. */
export type PageBodyWidth = "reading" | "wide";

/**
 * The routed-page frame: one scroll container and one centered column, with
 * the same `px-6 pt-6` gutter on every sibling page.
 */
export function PageBody({
	children,
	className,
	width = "reading",
}: {
	children: ReactNode;
	className?: string;
	width?: PageBodyWidth;
}) {
	return (
		<div className="scroll-fade h-full min-h-0 overflow-y-auto">
			<div
				className={cn(
					"mx-auto flex w-full flex-col gap-6 px-6 pt-6 pb-12",
					width === "wide" ? "max-w-6xl" : "max-w-3xl",
					className
				)}
			>
				{children}
			</div>
		</div>
	);
}

/**
 * A routed page's title row: the app `PageHeader` (one `h1`, one optional
 * subtitle line) with at most one action and an overflow menu at the right.
 */
export function PageTop({
	actions,
	subtitle,
	title,
}: {
	actions?: ReactNode;
	subtitle?: ReactNode;
	title: ReactNode;
}) {
	return (
		<header className="flex items-start justify-between gap-4">
			<PageHeader
				className="min-w-0"
				size="app"
				subtitle={subtitle}
				title={title}
			/>
			{actions ? (
				<div className="flex shrink-0 items-center gap-1">{actions}</div>
			) : null}
		</header>
	);
}

export interface PageMoreItem {
	disabled?: boolean;
	id: string;
	label: ReactNode;
	onSelect: () => void;
}

/** The `⋯` overflow for page actions beyond the one visible action. */
export function PageMoreMenu({
	items,
	label = "More actions",
}: {
	items: readonly PageMoreItem[];
	label?: string;
}) {
	if (items.length === 0) {
		return null;
	}
	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				render={
					<Button aria-label={label} size="icon-sm" variant="ghost-muted" />
				}
			>
				<HugeiconsIcon icon={MoreHorizontalIcon} size={16} />
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="min-w-44">
				{items.map((item) => (
					<DropdownMenuItem
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
