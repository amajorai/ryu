import { Button } from "@ryu/ui/components/button.tsx";
import { Logo as RyuLogo } from "@ryu/ui/components/logo";
import { Skeleton } from "@ryu/ui/components/skeleton.tsx";
import { Maximize, Minus, Plus } from "lucide-react";
import { AnimatePresence, motion, type Transition } from "motion/react";
import {
	type Dispatch,
	type RefObject,
	type SetStateAction,
	useEffect,
} from "react";
import type { FlowView } from "./flow-hooks.ts";
import { FlowMenu, FlowStartCard, flowMenuHeight } from "./flow-menu.tsx";
import type {
	FlowAction,
	FlowMenuSection,
	flowStartActions,
} from "./flow-model.ts";

export function FlowLoading() {
	return (
		<div
			aria-busy="true"
			aria-label="Loading"
			className="flex items-center gap-0"
			role="status"
		>
			<Skeleton className="size-10 rounded-full" />
			<span className="h-px w-16 bg-border" />
			<Skeleton className="h-10 w-44 rounded-lg" />
			<span className="h-px w-16 bg-border" />
			<Skeleton className="h-10 w-64 rounded-lg" />
		</div>
	);
}

/** The "New conversation" toggle and its floating menu, top right. */
export function FlowNewConversation({
	choose,
	newSections,
	panelW,
	reduceMotion,
	setStartOpen,
	size,
	startOpen,
	viewportRef,
}: {
	choose: (action: FlowAction) => void;
	newSections: FlowMenuSection[];
	panelW: number;
	reduceMotion: boolean;
	setStartOpen: Dispatch<SetStateAction<boolean>>;
	size: { height: number; width: number };
	startOpen: boolean;
	viewportRef: RefObject<HTMLDivElement | null>;
}) {
	return (
		<div
			className="absolute top-3 z-10"
			style={{
				right: panelW > 0 && panelW < size.width ? panelW + 12 : 12,
			}}
		>
			<Button
				aria-expanded={startOpen}
				aria-label="New conversation"
				data-flow-start-toggle=""
				onClick={() => setStartOpen((value) => !value)}
				size="icon-sm"
				title="New conversation"
				variant="ghost-muted"
			>
				<Plus aria-hidden="true" className="size-4 stroke-[1.75]" />
			</Button>
			<AnimatePresence>
				{startOpen ? (
					<motion.div
						animate={{ opacity: 1, y: 0 }}
						className="absolute top-10 right-0 w-[22rem] max-w-[calc(100vw-2rem)]"
						data-flow-start=""
						exit={{ opacity: 0, y: -4 }}
						initial={reduceMotion ? false : { opacity: 0, y: -4 }}
						transition={{ duration: reduceMotion ? 0 : 0.14 }}
					>
						<FlowMenu
							label="New conversation"
							maxHeight={Math.max(
								160,
								Math.min(flowMenuHeight(newSections), size.height - 72)
							)}
							onChoose={choose}
							onClose={() => {
								setStartOpen(false);
								viewportRef.current
									?.querySelector<HTMLElement>("[data-flow-start-toggle]")
									?.focus();
							}}
							sections={newSections}
						/>
					</motion.div>
				) : null}
			</AnimatePresence>
		</div>
	);
}

/** Zoom out / level / zoom in / fit, bottom left. */
export function FlowZoomToolbar({
	fitToScreen,
	shown,
	zoomBy,
}: {
	fitToScreen: () => void;
	shown: FlowView;
	zoomBy: (factor: number) => void;
}) {
	return (
		<div
			aria-label="Zoom"
			className="absolute bottom-4 left-4 z-10 flex h-8 items-center rounded-lg border border-border bg-background shadow-xs"
			role="toolbar"
		>
			<button
				aria-label="Zoom out"
				className="flex h-full w-8 items-center justify-center rounded-s-lg text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
				onClick={() => zoomBy(1 / 1.2)}
				type="button"
			>
				<Minus aria-hidden="true" className="size-3.5 stroke-[1.75]" />
			</button>
			<span className="w-11 border-border border-x text-center text-muted-foreground text-xs tabular-nums leading-[30px]">
				{Math.round(shown.k * 100)}%
			</span>
			<button
				aria-label="Zoom in"
				className="flex h-full w-8 items-center justify-center text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
				onClick={() => zoomBy(1.2)}
				type="button"
			>
				<Plus aria-hidden="true" className="size-3.5 stroke-[1.75]" />
			</button>
			<button
				aria-label="Fit to screen"
				className="flex h-full w-8 items-center justify-center rounded-e-lg border-border border-s text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
				onClick={fitToScreen}
				title="Fit to screen (0)"
				type="button"
			>
				<Maximize aria-hidden="true" className="size-3.5 stroke-[1.75]" />
			</button>
		</div>
	);
}

/** The first-run start card, centred while the flow is empty. */
export function FlowStartOverlay({
	choose,
	reduceMotion,
	starts,
	transition,
}: {
	choose: (action: FlowAction) => void;
	reduceMotion: boolean;
	starts: ReturnType<typeof flowStartActions>;
	transition: Transition;
}) {
	return (
		<div
			className="absolute inset-0 flex items-center justify-center overflow-y-auto px-4 py-12"
			data-flow-start=""
		>
			<motion.div
				animate={{ opacity: 1, y: 0 }}
				className="flex w-full justify-center"
				initial={reduceMotion ? false : { opacity: 0, y: 6 }}
				transition={transition}
			>
				<FlowStartCard
					actions={starts.short}
					allActions={starts.all}
					onChoose={choose}
				/>
			</motion.div>
		</div>
	);
}

/** The Ryu mark in the canvas's top-left corner. */
export function FlowCornerLogo() {
	return (
		<span
			aria-hidden="true"
			className="pointer-events-none absolute top-4 left-4 text-foreground"
		>
			<RyuLogo animated={false} size="20px" tone="inherit" variant="outline" />
		</span>
	);
}

/** Close floating menus on a press anywhere outside them. */
export function useFlowMenuDismiss(
	menuFor: string | null,
	startOpen: boolean,
	setMenuFor: Dispatch<SetStateAction<string | null>>,
	setStartOpen: Dispatch<SetStateAction<boolean>>
) {
	useEffect(() => {
		if (!(menuFor || startOpen)) {
			return;
		}
		const onDown = (event: PointerEvent) => {
			if (
				event.target instanceof Element &&
				event.target.closest(
					"[data-flow-menu], [data-flow-start], [aria-haspopup='menu'], [data-flow-start-toggle]"
				)
			) {
				return;
			}
			setMenuFor(null);
			setStartOpen(false);
		};
		document.addEventListener("pointerdown", onDown);
		return () => document.removeEventListener("pointerdown", onDown);
	}, [menuFor, setMenuFor, setStartOpen, startOpen]);
}
