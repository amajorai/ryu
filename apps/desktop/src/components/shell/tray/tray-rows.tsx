import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { Spinner } from "@ryu/ui/components/spinner.tsx";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import type { ReactNode } from "react";
import layoutStyles from "../TrayPopover.module.css";
import type { LayoutCssVariables } from "./tray-morph.tsx";

export type TrayTone = "default" | "danger" | "success" | "primary";

/** Row radius, concentric with the panel (20px panel − 6px padding). */
export const ROW_RADIUS = "rounded-xl";

/**
 * The count bubble for trays without a dedicated animated trigger. It stays
 * mounted so the transitions.dev notification-badge (03) can pop it in/out
 * rather than hard-mounting.
 */
export function TrayBadge({
	count,
	label,
	tone = "primary",
}: {
	count: number;
	/** Announced to screen readers; the number alone says nothing. */
	label: string;
	tone?: "primary" | "danger";
}) {
	const open = count > 0;
	return (
		<span
			aria-hidden={!open}
			aria-label={open ? `${count} ${label}` : undefined}
			className="t-badge -top-0.5 -right-0.5"
			data-open={open}
		>
			<span
				className={cn(
					"t-badge-dot flex h-4 min-w-4 items-center justify-center rounded-full px-1 font-medium text-xs tabular-nums ring-2 ring-sidebar",
					tone === "danger"
						? "bg-destructive text-white"
						: "bg-primary text-primary-foreground"
				)}
			>
				{count > 9 ? "9+" : count}
			</span>
		</span>
	);
}

/** The small glyph tile that leads every row. */
export function TrayRowIcon({
	className,
	icon,
	tone = "default",
}: {
	className?: string;
	icon: IconSvgElement;
	tone?: TrayTone;
}) {
	return (
		<span
			className={cn(
				"mt-px flex size-7 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground",
				tone === "danger" && "text-status-destructive",
				tone === "success" && "text-status-success",
				tone === "primary" && "text-primary",
				className
			)}
		>
			<HugeiconsIcon icon={icon} size={14} />
		</span>
	);
}

/**
 * A labelled affirmative action — the one control per row that must be read.
 * Filled default button (or success fill); outline chips used to wash out next
 * to icon ghosts and read as secondary.
 */
export function TrayAction({
	busy,
	label,
	onClick,
	tone = "primary",
}: {
	busy?: boolean;
	label: string;
	onClick: () => void;
	tone?: "primary" | "success";
}) {
	return (
		<button
			className={cn(
				"flex h-6 shrink-0 items-center gap-1 rounded-lg px-2 font-medium text-xs transition-colors disabled:opacity-60",
				tone === "success"
					? "bg-success text-white hover:bg-success/80"
					: "bg-primary text-primary-foreground hover:bg-primary/80"
			)}
			disabled={busy}
			onClick={onClick}
			type="button"
		>
			{busy && <Spinner className="size-3" />}
			{label}
		</button>
	);
}

/** A 24px ghost control. Icon-only, tooltipped, sized for a dense row. */
export function TrayIconAction({
	icon,
	label,
	onClick,
	tone = "default",
}: {
	icon: IconSvgElement;
	label: string;
	onClick: () => void;
	tone?: "default" | "danger";
}) {
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<button
						aria-label={label}
						className={cn(
							"flex size-6 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
							tone === "danger" &&
								"hover:bg-destructive/10 hover:text-status-destructive"
						)}
						onClick={onClick}
						type="button"
					>
						<HugeiconsIcon icon={icon} size={13} />
					</button>
				}
			/>
			<TooltipContent>{label}</TooltipContent>
		</Tooltip>
	);
}

/** Dot-separated meta segments, pre-truncated to one line. */
export function trayMeta(
	...parts: (string | null | undefined | false)[]
): string {
	return parts.filter(Boolean).join(" · ");
}

/**
 * The one row every tray list is built from.
 *
 * `onOpen` is wired as a full-bleed underlay button rather than by wrapping the
 * text: the whole row is then a single click target, and the action controls sit
 * above it instead of being nested inside another button (which is invalid, and
 * left the old rows with a hover highlight wider than their hit area).
 */
export function TrayRow({
	actions,
	busy,
	icon,
	iconNode,
	meta,
	metaTone = "default",
	onOpen,
	openLabel,
	progress,
	title,
	tone = "default",
	trailing,
}: {
	actions?: ReactNode;
	/** Swaps the whole action slot for a spinner, keeping the row's width. */
	busy?: boolean;
	icon?: IconSvgElement;
	/** A custom lead tile (an `<AppIcon/>`, a brand mark) that replaces the glyph.
	 *  When set, `tone` is ignored for the tile — the custom node owns its plate. */
	iconNode?: ReactNode;
	meta?: ReactNode;
	metaTone?: "default" | "danger";
	onOpen?: () => void;
	openLabel?: string;
	/** `undefined` draws no bar; `null` draws an indeterminate one. */
	progress?: number | null;
	title: ReactNode;
	tone?: TrayTone;
	/** Right-aligned stamp on the title line (kept out of the meta line). */
	trailing?: ReactNode;
}) {
	const cssVariables3: LayoutCssVariables = {
		"--desktop-inline5-width": `${progress}%`,
	};
	return (
		<div
			className={cn(
				"group/row relative flex items-start gap-2.5 px-2 py-2 transition-colors",
				ROW_RADIUS,
				onOpen && "hover:bg-muted/50"
			)}
		>
			{onOpen && (
				<button
					aria-label={openLabel}
					className={cn("absolute inset-0", ROW_RADIUS)}
					onClick={onOpen}
					type="button"
				/>
			)}
			{iconNode ?? (icon && <TrayRowIcon icon={icon} tone={tone} />)}
			{/* Text ignores the pointer only when there's an underlay button to fall
			    through to; otherwise it would swallow its own `title` tooltip. */}
			<div
				className={cn(
					"relative flex min-w-0 flex-1 flex-col",
					onOpen && "pointer-events-none"
				)}
			>
				<div className="flex items-baseline gap-2">
					<span className="text-(length:--text-detail) min-w-0 flex-1 truncate font-medium leading-5">
						{title}
					</span>
					{trailing && (
						<span className="shrink-0 text-muted-foreground/70 text-xs tabular-nums">
							{trailing}
						</span>
					)}
				</div>
				{meta && (
					<span
						className={cn(
							"mt-0.5 truncate text-xs tabular-nums leading-4",
							metaTone === "danger"
								? "text-status-destructive/90"
								: "text-muted-foreground"
						)}
					>
						{meta}
					</span>
				)}
				{progress !== undefined && (
					// Under the meta line, not between it and the title: sitting directly
					// beneath the title the bar read as an underline rather than as
					// progress. The track is explicit so a barely-started download still
					// shows how far it has to go.
					<div className="relative mt-2 h-[3px] overflow-hidden rounded-full bg-foreground/10">
						{progress === null ? (
							<span className="t-progress-marquee" />
						) : (
							<div
								className={cn(
									cn(
										"h-full rounded-full bg-primary/80 duration-500 ease-out",
										layoutStyles.authored4
									),
									layoutStyles.inline5
								)}
								style={cssVariables3}
							/>
						)}
					</div>
				)}
			</div>
			<div className="relative flex shrink-0 items-center gap-1">
				{busy ? (
					<span className="flex size-6 items-center justify-center">
						<span className={"size-3.5 text-muted-foreground"}>
							<Spinner />
						</span>
					</span>
				) : (
					actions
				)}
			</div>
		</div>
	);
}
