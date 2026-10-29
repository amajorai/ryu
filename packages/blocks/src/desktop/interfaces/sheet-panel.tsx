import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Kbd, KbdGroup } from "@ryu/ui/components/kbd.tsx";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip.tsx";
import { cn } from "@ryu/ui/lib/utils";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import { motion } from "motion/react";
import type { KeyboardEvent, ReactNode } from "react";
import { BoardAvatar } from "./board-avatar.tsx";
import { SheetStatusPill } from "./sheet-cells.tsx";
import type { SheetRow } from "./sheet-model.ts";

/**
 * Key caps on the tooltip's muted glass: the shared Kbd assumes an inverted
 * tooltip, so its caps would vanish here; keep them on a card-like chip.
 */
const TOOLTIP_KBD =
	"in-data-[slot=tooltip-content]:bg-background/85 in-data-[slot=tooltip-content]:text-foreground/70 in-data-[slot=tooltip-content]:shadow-xs dark:in-data-[slot=tooltip-content]:bg-background/60";

function PanelIconButton({
	disabled,
	hint,
	icon,
	label,
	onClick,
}: {
	disabled?: boolean;
	/** Key caps shown after the label, e.g. ["Alt", "↑"]. */
	hint?: readonly string[];
	icon: ReactNode;
	label: string;
	onClick: () => void;
}) {
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<Button
						aria-label={label}
						disabled={disabled}
						onClick={onClick}
						size="icon-sm"
						type="button"
						variant="ghost"
					/>
				}
			>
				{icon}
			</TooltipTrigger>
			<TooltipContent side="bottom">
				{label}
				{hint ? (
					<KbdGroup>
						{hint.map((key) => (
							<Kbd className={TOOLTIP_KBD} key={key}>
								{key}
							</Kbd>
						))}
					</KbdGroup>
				) : null}
			</TooltipContent>
		</Tooltip>
	);
}

/**
 * The open thread beside the grid, like an expanded record: a slim header
 * (status, title, who, record stepping, close) over the host's real chat.
 */
export function SheetThreadPanel({
	onClose,
	onStep,
	overlay,
	position,
	row,
	threadView,
	total,
}: {
	onClose: () => void;
	onStep: (offset: -1 | 1) => void;
	/** Narrow layouts cover the grid instead of sitting beside it. */
	overlay: boolean;
	/** Zero-based index of the row in the visible sheet, or -1 when not in it. */
	position: number;
	row: SheetRow | undefined;
	threadView: ReactNode;
	total: number;
}) {
	const tl = useLiteralMessages();
	const title = row?.title ?? "New thread";
	const lead = row?.agents[0];
	const where = [
		{ kind: "team", name: row?.team },
		{ kind: "project", name: row?.project },
	].filter((item) => Boolean(item.name));
	const canStep = position >= 0;
	let positionLabel = row
		? "Hidden by the current filter"
		: "Not in the sheet yet";
	if (canStep) {
		positionLabel = tl("Row {rowNumber} of {total}", {
			rowNumber: String(position + 1),
			total: String(total),
		});
	}
	// Alt+Up/Down steps through records while focus is in the panel header,
	// the way an expanded record pages through its table.
	const onHeaderKeyDown = (event: KeyboardEvent<HTMLElement>) => {
		if (!(canStep && event.altKey)) {
			return;
		}
		if (event.key === "ArrowUp" && position > 0) {
			event.preventDefault();
			onStep(-1);
		} else if (event.key === "ArrowDown" && position < total - 1) {
			event.preventDefault();
			onStep(1);
		}
	};
	return (
		<motion.aside
			animate={{ opacity: 1, x: 0 }}
			aria-label={tl("Thread: {threadTitle}", { threadTitle: title })}
			className={cn(
				"flex min-h-0 flex-col bg-background",
				overlay
					? "absolute inset-0 z-40"
					: "relative w-[clamp(340px,40%,680px)] shrink-0 border-border border-l"
			)}
			data-testid="sheet-thread-panel"
			exit={{ opacity: 0, x: 24 }}
			initial={{ opacity: 0, x: 24 }}
			transition={{ duration: 0.2, ease: [0.2, 0, 0, 1] }}
		>
			{/* biome-ignore lint/a11y/noNoninteractiveElementInteractions: the header only forwards Alt+Arrow from its own buttons to step records. */}
			<header
				className="flex shrink-0 flex-col gap-1.5 border-border border-b px-3 py-2.5"
				onKeyDown={onHeaderKeyDown}
			>
				<div className="flex min-w-0 items-center gap-2">
					<h3 className="min-w-0 flex-1 truncate font-medium text-foreground text-sm leading-6">
						{title}
					</h3>
					<div className="-me-1 flex shrink-0 items-center">
						{canStep ? (
							<>
								<PanelIconButton
									disabled={position <= 0}
									hint={["Alt", "↑"]}
									icon={<ChevronUp aria-hidden="true" />}
									label="Previous thread"
									onClick={() => onStep(-1)}
								/>
								<PanelIconButton
									disabled={position >= total - 1}
									hint={["Alt", "↓"]}
									icon={<ChevronDown aria-hidden="true" />}
									label="Next thread"
									onClick={() => onStep(1)}
								/>
							</>
						) : null}
						<PanelIconButton
							hint={["Esc"]}
							icon={<X aria-hidden="true" />}
							label="Close thread"
							onClick={onClose}
						/>
					</div>
				</div>
				{row ? (
					<div className="flex min-w-0 items-center gap-3 text-muted-foreground text-xs">
						<SheetStatusPill status={row.status} />
						{lead ? (
							<span className="flex min-w-0 items-center gap-1.5">
								<BoardAvatar
									agent={lead}
									className="size-4"
									name={lead.name}
									size={20}
								/>
								<span className="truncate text-foreground">
									{row.agents.map((agent) => agent.name).join(", ")}
								</span>
							</span>
						) : null}
						{where.map((item) => (
							<span className="min-w-0 truncate" key={item.kind}>
								{item.name}
							</span>
						))}
						<span className="ms-auto shrink-0 tabular-nums">
							{positionLabel}
						</span>
					</div>
				) : (
					<p className="text-muted-foreground text-xs">{positionLabel}</p>
				)}
			</header>
			<div className="min-h-0 flex-1" data-sheet-thread-view="">
				{threadView}
			</div>
		</motion.aside>
	);
}
