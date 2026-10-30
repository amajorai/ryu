import { cn } from "@ryu/ui/lib/utils";
import { THREAD_STATUS_LABELS } from "@ryuhq/protocol/interfaces";
import { type CSSProperties, createContext, useContext } from "react";
import { BoardStatusDot } from "./board-status.tsx";
import {
	cropTitle,
	type FarmCrop,
	type FarmPlot,
	FRUIT_NAMES,
} from "./farm-model.ts";
import { PlantGlyph } from "./farm-plants.tsx";
import { compactAge } from "./interface-renderer.ts";

/**
 * A crop in a list. In the barn its section already names the status, so
 * the row names the crop and its plot; in a plot it names the status.
 */
export function CropRow({
	active,
	crop,
	onOpen,
	plotName,
}: {
	active: boolean;
	crop: FarmCrop;
	onOpen: (threadId: string) => void;
	plotName?: string;
}) {
	// With acts a crop row carries no legacy status or last-update age.
	const actMode = useContext(FarmActMode);
	let detail = `${THREAD_STATUS_LABELS[crop.status]} · ${FRUIT_NAMES[crop.fruit]}`;
	if (plotName) {
		detail = `${FRUIT_NAMES[crop.fruit]} · ${plotName}`;
	} else if (actMode) {
		detail = FRUIT_NAMES[crop.fruit];
	}
	return (
		<li>
			<button
				aria-current={active ? "true" : undefined}
				className={cn(
					"grid w-full grid-cols-[2rem_minmax(0,1fr)_2.5rem] items-center gap-3 rounded-md px-2 py-2 text-left outline-none transition-colors duration-150 hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring",
					active && "bg-muted"
				)}
				data-testid="farm-row"
				onClick={() => onOpen(crop.thread.id)}
				type="button"
			>
				<PlantGlyph className="size-8" fruit={crop.fruit} stage={crop.stage} />
				<span className="flex min-w-0 flex-col gap-0.5">
					<span className="truncate font-medium text-foreground text-sm">
						{cropTitle(crop.thread)}
					</span>
					<span className="flex min-w-0 items-center gap-1.5 text-[13px] text-muted-foreground">
						{actMode ? null : <BoardStatusDot status={crop.status} />}
						<span className="truncate">{detail}</span>
					</span>
				</span>
				<span className="self-start pt-0.5 text-right text-[13px] text-muted-foreground tabular-nums">
					{actMode ? null : compactAge(crop.thread.updatedAt)}
				</span>
			</button>
		</li>
	);
}

/** Whether the act layer is on (the panel's rows then follow it). */
export const FarmActMode = createContext(false);

/** The stall's striped awning edge along the top of the ledger. */
const AWNING: CSSProperties = {
	backgroundImage:
		"repeating-linear-gradient(90deg, var(--border) 0 12px, transparent 12px 24px)",
};

/**
 * The market-stall ledger under an open conversation's title: one ruled
 * entry for the crop (whose plot, which crop, where it stands) with what it
 * has earned in a right-aligned coins column.
 */
export function Ledger({
	crop,
	plot,
}: {
	crop: FarmCrop;
	plot: FarmPlot | undefined;
}) {
	const label = "text-[13px] text-muted-foreground";
	// With acts the ledger drops the thread's legacy status.
	const actMode = useContext(FarmActMode);
	return (
		<div className="shrink-0 border-border border-b" data-testid="farm-ledger">
			<div
				aria-hidden="true"
				className="h-2 border-border border-b"
				style={AWNING}
			/>
			<dl className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto] text-sm">
				<div className="flex min-w-0 flex-col gap-1 py-2.5 pl-4">
					<dt className={label}>Plot</dt>
					<dd className="truncate font-medium text-foreground">
						{plot?.name ?? "Shared bed"}
					</dd>
				</div>
				<div className="flex min-w-0 flex-col gap-1 py-2.5 pl-3">
					<dt className={label}>Crop</dt>
					<dd className="truncate text-foreground">
						{FRUIT_NAMES[crop.fruit]}
					</dd>
				</div>
				{actMode ? null : (
					<div className="flex min-w-0 flex-col gap-1 py-2.5 pl-3">
						<dt className={label}>Status</dt>
						<dd className="flex min-w-0 items-center gap-1.5 text-foreground">
							<BoardStatusDot status={crop.status} />
							<span className="truncate">
								{THREAD_STATUS_LABELS[crop.status]}
							</span>
						</dd>
					</div>
				)}
				<div className="flex min-w-16 flex-col items-end gap-1 border-border border-l py-2.5 pr-4 pl-3">
					<dt className={label}>Coins</dt>
					<dd
						className="font-medium text-foreground tabular-nums"
						data-testid="farm-ledger-coins"
					>
						{crop.thread.messageCount}
					</dd>
				</div>
			</dl>
		</div>
	);
}
