import { cn } from "@ryu/ui/lib/utils";
import { Minus, Plus, ScanSearch, SquarePen } from "lucide-react";
import type { ReactNode } from "react";
import { GAME_PLATE, GameAction, GameIconButton } from "./game-hud.tsx";

/** Top-right: zoom, back to the overview, and a new thread. */
export function PlanetsControls({
	children,
	compact = false,
	disabled,
	onNewThread,
	onOverview,
	onZoom,
	showCamera,
	stacked = false,
}: {
	/** The act layer's HUD actions (Need you, Queue), after New thread. */
	children?: ReactNode;
	/** Narrow scenes: the action shows its icon only. */
	compact?: boolean;
	disabled: boolean;
	onNewThread: () => void;
	onOverview: () => void;
	onZoom: (factor: number) => void;
	showCamera: boolean;
	/** A phone with the act layer's actions: one column down the right. */
	stacked?: boolean;
}) {
	return (
		<div
			className={cn(
				"pointer-events-auto flex shrink-0 items-start @min-[672px]:gap-3 gap-2",
				stacked && "flex-col items-end"
			)}
			data-planets-hud="controls"
		>
			{showCamera ? (
				<div
					aria-label="Camera"
					className={cn(
						GAME_PLATE,
						"flex @max-[560px]:hidden items-center gap-1.5 p-1"
					)}
					role="group"
				>
					<GameIconButton
						disabled={disabled}
						label="Zoom in"
						onClick={() => onZoom(0.72)}
						title="Zoom in"
					>
						<Plus aria-hidden="true" className="size-5" strokeWidth={2.75} />
					</GameIconButton>
					<GameIconButton
						disabled={disabled}
						label="Zoom out"
						onClick={() => onZoom(1.38)}
						title="Zoom out"
					>
						<Minus aria-hidden="true" className="size-5" strokeWidth={2.75} />
					</GameIconButton>
					<GameIconButton
						disabled={disabled}
						label="Overview"
						onClick={onOverview}
						title="Back to the overview"
					>
						<ScanSearch
							aria-hidden="true"
							className="size-5"
							strokeWidth={2.5}
						/>
					</GameIconButton>
				</div>
			) : null}
			<GameAction
				compact={compact}
				disabled={disabled}
				icon={<SquarePen strokeWidth={2.5} />}
				label="New thread"
				onClick={onNewThread}
			/>
			{children}
		</div>
	);
}
