import { cn } from "@ryu/ui/lib/utils";
import type { ReactNode } from "react";
import { frameStyle, SV_TEXT } from "./world-2d-frame.ts";
import { QuestMark } from "./world-2d-hud-clock.tsx";
import {
	SLOT_BUTTON,
	SLOT_FRAME_SCALE,
	SLOT_SIZE,
	type SlotSize,
} from "./world-2d-hud-hotbar-layout.ts";
import { needsYou, type VillagerStatus } from "./world-2d-model.ts";
import { SV_ICONS, SV_UI } from "./world-2d-palette.ts";

export function MapIcon({ size }: { size: number }) {
	return (
		<svg
			aria-hidden="true"
			height={size}
			shapeRendering="crispEdges"
			viewBox="0 0 10 10"
			width={size}
		>
			<path
				d="M0 1h3v1h1v-1h3v1h3v8h-3v-1h-1v1h-3v-1h-3z"
				fill={SV_UI.woodDark}
			/>
			<path d="M1 2h2v7h-2zM4 2h2v7h-2zM7 3h2v6h-2z" fill={SV_UI.key} />
			<path d="M3 2h1v7h-1zM6 2h1v7h-1z" fill={SV_UI.keyShade} />
			<path d="M1 4h1v1h-1zM4 6h2v1h-2zM8 4h1v1h-1z" fill={SV_UI.green} />
			<path d="M7 6h1v1h-1z" fill={SV_ICONS.dialHand} />
		</svg>
	);
}

/**
 * A slot's corner marks sit 2px inside its bevel. The frame is 5 frame
 * pixels deep and its bevel 3, so from the slot's padding box that is
 * `2 - 2 * scale` CSS px (negative: into the frame's flat fill).
 */
function cornerInset(frameScale: number): number {
	return 2 - 2 * frameScale;
}

/** Small corner label on a slot (its key), inside the well past the bevel. */
export function SlotKeyLabel({
	children,
	frameScale,
}: {
	children: ReactNode;
	frameScale: number;
}) {
	const inset = cornerInset(frameScale);
	return (
		<span
			aria-hidden="true"
			className="font-(family-name:--sv-font) absolute z-10 font-normal text-[8px] leading-none [font-synthesis:none]"
			style={{ ...SV_TEXT, left: inset, top: inset }}
		>
			{children}
		</span>
	);
}

/**
 * A villager's status on its hotbar slot, in the top-right corner 2px inside
 * the bevel: the "!" quest marker when they are waiting on the user, a "..."
 * while they work, nothing otherwise. Both badges share one 12x14 box.
 */
export function SlotStatus({
	size,
	status,
}: {
	size: SlotSize;
	status: VillagerStatus;
}) {
	const working = status === "working";
	if (!(working || needsYou(status))) {
		return null;
	}
	const inset = cornerInset(SLOT_FRAME_SCALE[size]);
	return (
		<span
			aria-hidden="true"
			className="absolute z-10 flex h-3.5 w-3 items-center justify-center gap-px border border-(--sv-outline) bg-(--sv-plank-ink)"
			style={{ right: inset, top: inset }}
		>
			{working ? (
				[0, 1, 2].map((dot) => (
					<span className="size-0.5 shrink-0 bg-(--sv-ink)" key={dot} />
				))
			) : (
				<QuestMark
					size={10}
					tone={status === "attention" ? "attention" : "your-turn"}
				/>
			)}
		</span>
	);
}

/**
 * The controls slot's item: a closed guide book (Stardew's hotbar holds
 * items, so the controls are a book, not a bare "?").
 */
function ControlsIcon({ size }: { size: number }) {
	return (
		<svg
			aria-hidden="true"
			height={size}
			shapeRendering="crispEdges"
			viewBox="0 0 10 10"
			width={size}
		>
			<path d="M1 0h8v10h-8z" fill={SV_UI.woodDark} />
			<path d="M2 1h6v7h-6z" fill={SV_ICONS.leafVein} />
			<path d="M3 1h5v7h-5z" fill={SV_UI.green} />
			<path d="M2 8h7v1h-7z" fill={SV_UI.parchment} />
			<path d="M4 3h3v1h-3zM4 5h2v1h-2z" fill={SV_UI.key} />
		</svg>
	);
}

/** The controls slot: the hotbar's, or the small one by the place name. */
export function HelpButton({
	frameScale = 2,
	open,
	onToggle,
	size,
}: {
	/** Screen pixels per frame pixel. */
	frameScale?: number;
	onToggle: () => void;
	open: boolean;
	/** Slot size in CSS px. */
	size: number;
}) {
	return (
		<button
			aria-keyshortcuts="?"
			aria-label="Controls"
			aria-pressed={open}
			className={cn(SLOT_BUTTON, "pointer-events-auto")}
			onClick={onToggle}
			style={{
				...frameStyle(open ? "slot-pressed" : "slot", frameScale),
				height: size,
				width: size,
			}}
			title="Controls (?)"
			type="button"
		>
			<ControlsIcon size={size >= SLOT_SIZE.full ? 30 : 20} />
			<SlotKeyLabel frameScale={frameScale}>?</SlotKeyLabel>
		</button>
	);
}
