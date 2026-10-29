import { Logo as RyuLogo } from "@ryu/ui/components/logo";
import { cn } from "@ryu/ui/lib/utils";
import { ArrowRight, Plus } from "lucide-react";
import {
	type KeyboardEvent,
	type Ref,
	type RefObject,
	useCallback,
	useEffect,
	useId,
	useRef,
	useState,
} from "react";
import type { FlowAction, FlowMenuSection } from "./flow-model.ts";
import { FlowActionGlyph } from "./flow-parts.tsx";

/** Arrow/Home/End travel between the `[data-flow-item]` buttons in a list. */
function moveFocus(event: KeyboardEvent<HTMLElement>): void {
	const keys = ["ArrowDown", "ArrowUp", "Home", "End"];
	if (!keys.includes(event.key)) {
		return;
	}
	const items = [
		...event.currentTarget.querySelectorAll<HTMLElement>("[data-flow-item]"),
	];
	if (items.length === 0) {
		return;
	}
	event.preventDefault();
	event.stopPropagation();
	const index = items.indexOf(document.activeElement as HTMLElement);
	let next = 0;
	if (event.key === "End") {
		next = items.length - 1;
	} else if (event.key === "ArrowDown") {
		next = index < 0 ? 0 : (index + 1) % items.length;
	} else if (event.key === "ArrowUp") {
		next = index <= 0 ? items.length - 1 : index - 1;
	}
	items[next]?.focus();
}

function ActionText({ action }: { action: FlowAction }) {
	return (
		<span className="flex min-w-0 flex-1 flex-col">
			<span className="truncate font-medium text-[13px] text-foreground leading-5">
				{action.title}
			</span>
			<span className="truncate text-muted-foreground text-xs leading-4">
				{action.description}
			</span>
		</span>
	);
}

/**
 * The first thing on an empty canvas: the app mark and a short stack of ways
 * to start, each with a "+" that drops it onto the canvas.
 */
export function FlowStartCard({
	actions,
	allActions,
	onChoose,
}: {
	actions: FlowAction[];
	allActions: FlowAction[];
	onChoose: (action: FlowAction) => void;
}) {
	const [showAll, setShowAll] = useState(false);
	const shown = showAll ? allActions : actions;
	const more = allActions.length > actions.length;
	return (
		<section
			aria-label="Start"
			className="flex w-full max-w-[22rem] flex-col items-center gap-6"
		>
			<span aria-label="Ryu" className="text-foreground" role="img">
				<RyuLogo
					animated={false}
					size="32px"
					tone="inherit"
					variant="outline"
				/>
			</span>
			<FlowActionList
				actions={shown}
				footer={
					more ? (
						<button
							aria-expanded={showAll}
							className="flex h-9 w-full items-center justify-between rounded-b-[11px] px-3 text-[13px] text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/30"
							onClick={() => setShowAll((value) => !value)}
							type="button"
						>
							{showAll ? "Show fewer" : "View all"}
							<ArrowRight
								aria-hidden="true"
								className={cn(
									"size-3.5 stroke-[1.75] transition-transform duration-150",
									showAll && "-rotate-90"
								)}
							/>
						</button>
					) : null
				}
				label="Ways to start"
				onChoose={onChoose}
			/>
		</section>
	);
}

/** A framed list of actions; the frame's lower lip holds an optional footer. */
export function FlowActionList({
	actions,
	className,
	footer,
	label,
	listRef,
	onChoose,
}: {
	actions: FlowAction[];
	className?: string;
	footer?: React.ReactNode;
	label: string;
	listRef?: Ref<HTMLDivElement>;
	onChoose: (action: FlowAction) => void;
}) {
	return (
		<div
			className={cn(
				"w-full rounded-xl border border-border bg-muted/50 p-[3px]",
				className
			)}
		>
			{/* biome-ignore lint/a11y/noStaticElementInteractions: arrow keys move focus between the list's buttons */}
			<div
				aria-label={label}
				className="flex max-h-[min(26rem,60vh)] flex-col divide-y divide-border overflow-y-auto rounded-[9px] border border-border bg-card shadow-xs"
				data-flow-scroll=""
				onKeyDown={moveFocus}
				ref={listRef}
				role="group"
			>
				{actions.map((action) => (
					<button
						className="group flex w-full items-center gap-3 px-3 py-2.5 text-left outline-none transition-colors first:rounded-t-[8px] last:rounded-b-[8px] hover:bg-muted/50 focus-visible:bg-muted/60"
						data-flow-item=""
						key={action.id}
						onClick={() => onChoose(action)}
						type="button"
					>
						<FlowActionGlyph action={action} />
						<ActionText action={action} />
						<Plus
							aria-hidden="true"
							className="size-3.5 shrink-0 stroke-[1.75] text-muted-foreground transition-colors group-hover:text-foreground"
						/>
					</button>
				))}
			</div>
			{footer}
		</div>
	);
}

/** Height of one menu row, its section label, and the gap between sections. */
export const FLOW_MENU_ROW = 44;
const MENU_LABEL = 24;
const MENU_GAP = 9;
const MENU_INSET = 10;

/** The natural height of a sectioned menu, before any max-height applies. */
export function flowMenuHeight(sections: FlowMenuSection[]): number {
	let height = MENU_INSET;
	for (const [index, section] of sections.entries()) {
		height += section.items.length * FLOW_MENU_ROW;
		height += section.label ? MENU_LABEL : 0;
		height += index > 0 ? MENU_GAP : 0;
	}
	return height;
}

/** True while a scroller has more content below its fold. */
function useMoreBelow(ref: RefObject<HTMLElement | null>): {
	more: boolean;
	update: () => void;
} {
	const [more, setMore] = useState(false);
	const update = useCallback(() => {
		const element = ref.current;
		if (!element) {
			return;
		}
		setMore(
			element.scrollHeight - element.scrollTop - element.clientHeight > 2
		);
	}, [ref]);
	useEffect(() => {
		update();
	}, [update]);
	return { more, update };
}

/**
 * A sectioned list of actions in one popover surface: quiet section labels,
 * hairline dividers, and a fade at the fold while more rows sit below it.
 */
export function FlowMenu({
	className,
	label,
	labelledBy,
	maxHeight,
	onChoose,
	onClose,
	sections,
}: {
	className?: string;
	label?: string;
	labelledBy?: string;
	maxHeight: number;
	onChoose: (action: FlowAction) => void;
	onClose: () => void;
	sections: FlowMenuSection[];
}) {
	const menuRef = useRef<HTMLDivElement>(null);
	const { more, update } = useMoreBelow(menuRef);
	const baseId = useId();
	useEffect(() => {
		menuRef.current
			?.querySelector<HTMLElement>("[data-flow-item]")
			?.focus({ preventScroll: true });
	}, []);
	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (event.key === "Escape" || event.key === "Tab") {
			event.preventDefault();
			event.stopPropagation();
			onClose();
			return;
		}
		moveFocus(event);
	};
	return (
		<div
			aria-label={label}
			aria-labelledby={labelledBy}
			className={cn(
				"flex flex-col overflow-y-auto rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-lg",
				className
			)}
			data-flow-scroll=""
			onKeyDown={onKeyDown}
			onScroll={update}
			ref={menuRef}
			role="menu"
			style={{ maxHeight }}
		>
			{sections.map((section, index) => {
				const headingId = `${baseId}-${section.id}`;
				return (
					<div
						aria-labelledby={section.label ? headingId : undefined}
						className={cn(
							"flex flex-col",
							index > 0 && "mt-1 border-border border-t pt-1"
						)}
						key={section.id}
						role="group"
					>
						{section.label ? (
							<div
								className="flex h-6 items-center px-2 font-medium text-[11px] text-muted-foreground"
								id={headingId}
							>
								{section.label}
							</div>
						) : null}
						{section.items.map((action) => (
							<button
								className="flex h-11 w-full shrink-0 items-center gap-2.5 rounded-md px-2 text-left outline-none transition-colors hover:bg-muted focus-visible:bg-muted"
								data-flow-item=""
								key={action.id}
								onClick={() => onChoose(action)}
								role="menuitem"
								tabIndex={-1}
								type="button"
							>
								<FlowActionGlyph action={action} />
								<ActionText action={action} />
							</button>
						))}
					</div>
				);
			})}
			{/* The fold hint fades into the menu's own surface, so nothing behind
			    the menu ever shows through it. */}
			{more ? (
				<div
					aria-hidden="true"
					className="pointer-events-none sticky -bottom-1 -mx-1 -mt-8 -mb-1 h-8 shrink-0 bg-linear-to-t from-popover to-transparent"
				/>
			) : null}
		</div>
	);
}

/**
 * "Connect to <node>": the sectioned menu a dotted "+" stub opens. It lives in
 * screen space beside the stub so it stays legible at any zoom.
 */
export function FlowConnectMenu({
	left,
	maxHeight,
	onChoose,
	onClose,
	sections,
	title,
	top,
}: {
	left: number;
	maxHeight: number;
	onChoose: (action: FlowAction) => void;
	onClose: () => void;
	sections: FlowMenuSection[];
	title: string;
	top: number;
}) {
	const labelId = useId();
	return (
		<div className="absolute z-20 w-80" data-flow-menu="" style={{ left, top }}>
			<div
				className="inline-flex h-7 items-center rounded-t-lg border border-border border-b-0 bg-muted px-2.5 text-muted-foreground text-xs"
				id={labelId}
			>
				{title}
			</div>
			<FlowMenu
				className="-mt-px rounded-tl-none"
				labelledBy={labelId}
				maxHeight={maxHeight}
				onChoose={onChoose}
				onClose={onClose}
				sections={sections}
			/>
		</div>
	);
}
