import { cn } from "@ryu/ui/lib/utils";
import type { ReactNode } from "react";
import { frameStyle, SV_PLANK_TEXT, SV_TEXT } from "./world-2d-frame.ts";
import { HUD_FONT, PixelKey } from "./world-2d-hud-chrome.tsx";

/**
 * The 2D village's Stardew-style HUD: wooden frames with parchment insides,
 * the clock and date box (top right), the location plaque (top left), the
 * hotbar with one slot per villager (bottom), the interaction tooltip above
 * it, and a toggleable village map. One face and weight throughout (the
 * app's display face, semibold) at two sizes, 16px and 13px. Colors are
 * Stardew's menu colors from `world-2d-palette.ts`, read through the
 * `--sv-*` variables the world sets on its root.
 */

export { CloseButton, PixelKey } from "./world-2d-hud-chrome.tsx";
export {
	ClockBox,
	QuestMark,
	stardewTime,
	WorkingDots,
} from "./world-2d-hud-clock.tsx";
export {
	Hotbar,
	type HotbarAgent,
	HotbarPlaceholder,
} from "./world-2d-hud-hotbar.tsx";
export {
	type HotbarLayout,
	hotbarLayout,
	SLOT_SIZE,
	type SlotSize,
} from "./world-2d-hud-hotbar-layout.ts";
export { VillageMap } from "./world-2d-hud-map.tsx";
export { HelpButton } from "./world-2d-hud-slots.tsx";

/** The place name, on a parchment card in the same wood frame as the clock. */
export function LocationPlaque({ title }: { title: string }) {
	return (
		<p
			className={cn("pointer-events-none text-[16px] leading-none", HUD_FONT)}
			style={{ ...frameStyle("wood"), ...SV_TEXT }}
		>
			{title}
		</p>
	);
}

/**
 * The interaction tooltip above the hotbar (polite live region). With
 * nothing to say it stays mounted but empty, so announcements keep working.
 */
export function PromptTooltip({
	children,
	visuallyHidden = false,
}: {
	children: ReactNode;
	/** Announce without showing the plank (e.g. "Loading villagers"). */
	visuallyHidden?: boolean;
}) {
	const empty = visuallyHidden || children === null || children === undefined;
	return (
		<div
			aria-live="polite"
			className={cn(
				"max-w-full text-center text-[16px] leading-5",
				HUD_FONT,
				empty && "sr-only"
			)}
			role="status"
			style={
				empty ? undefined : { ...frameStyle("plank", 2), ...SV_PLANK_TEXT }
			}
		>
			{children}
		</div>
	);
}

/** The controls hint on its own wooden plank (not a live region). */
export function ControlsPlank({ children }: { children: ReactNode }) {
	return (
		<p
			className={cn("text-left text-[16px] leading-5", HUD_FONT)}
			style={{ ...frameStyle("plank", 2), ...SV_PLANK_TEXT }}
		>
			<span className="sr-only">Controls: </span>
			{children}
		</p>
	);
}

/**
 * What the controls strip leaves behind once closed: a small plank with
 * its "?" key, so the strip can be brought back with the mouse too.
 */
export function ControlsToggle({ onToggle }: { onToggle: () => void }) {
	return (
		<button
			aria-keyshortcuts="?"
			aria-label="Show controls"
			className={cn(
				"pointer-events-auto flex items-center text-[16px] leading-5 outline-none hover:brightness-110 focus-visible:outline-(--sv-focus) focus-visible:outline-2 focus-visible:outline-offset-2 active:translate-y-px",
				HUD_FONT
			)}
			onClick={onToggle}
			style={{ ...frameStyle("plank", 2), ...SV_PLANK_TEXT }}
			title="Show controls (?)"
			type="button"
		>
			<PixelKey>?</PixelKey>
		</button>
	);
}

/**
 * The village with nobody in it: a notice on the square explaining that
 * agents move in here, and a way to start a conversation (no prompt is
 * sent; the host's new-thread flow takes over).
 */
export function EmptyVillage({ onStart }: { onStart: () => void }) {
	return (
		<section
			aria-labelledby="world-2d-empty-title"
			className={cn(
				"pointer-events-auto absolute top-1/2 left-1/2 flex w-[min(360px,calc(100%-24px))] -translate-x-1/2 -translate-y-1/2 flex-col gap-2",
				HUD_FONT
			)}
			style={{ ...frameStyle("wood"), ...SV_TEXT }}
		>
			<h2
				className="font-(family-name:--sv-font) font-normal text-[16px] leading-6 [font-synthesis:none]"
				id="world-2d-empty-title"
			>
				No villagers yet
			</h2>
			<p className="text-(--sv-ink-soft) text-[16px] leading-6">
				Every agent you create moves into a cottage on this street, with a
				hotbar slot to visit them from anywhere.
			</p>
			<button
				className="mt-2 inline-flex h-8 items-center self-start text-[16px] leading-none outline-none hover:brightness-110 focus-visible:outline-(--sv-focus) focus-visible:outline-2 focus-visible:outline-offset-2 active:translate-y-px"
				onClick={onStart}
				style={{ ...frameStyle("plank", 2), ...SV_PLANK_TEXT }}
				type="button"
			>
				Start a conversation
			</button>
		</section>
	);
}
