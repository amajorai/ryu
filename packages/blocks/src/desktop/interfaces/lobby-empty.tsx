import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import { SQUAD_SIZE } from "./lobby-model.ts";
import { STAGE_BACKGROUND, STAGE_FLOOR, STAGE_RAYS } from "./lobby-palette.ts";
import { ChunkyButton, DISPLAY, KICKER } from "./lobby-parts.tsx";

/** One dashed standee outline: a squad slot nobody fills yet. */
function OpenSlot({ lead }: { lead: boolean }) {
	return (
		<span
			aria-hidden="true"
			className={cn(
				"flex aspect-[17/31] items-center justify-center border-2 border-dashed",
				lead
					? "w-[min(30cqw,150px)] border-foreground/30 text-foreground/50"
					: "w-[min(22cqw,110px)] border-foreground/15 text-foreground/30"
			)}
		>
			<span className={cn(DISPLAY, lead ? "text-[48px]" : "text-[32px]")}>
				+
			</span>
		</span>
	);
}

/**
 * No agents and no threads: the stage stays up with four open slots, so the
 * empty lobby reads as the same screen waiting for its squad.
 */
export function LobbyEmpty({
	onStart,
	size = SQUAD_SIZE,
}: {
	onStart: () => void;
	/** The squad's size (the "Squad size" setting). */
	size?: number;
}) {
	const tl = useLiteralMessages();
	return (
		<section
			aria-labelledby="lobby-empty-title"
			className="@container relative flex min-h-0 flex-1 flex-col items-center justify-center gap-10 overflow-hidden px-8 py-8 max-sm:px-4"
			style={{ background: STAGE_BACKGROUND }}
		>
			<div
				aria-hidden="true"
				className="pointer-events-none absolute inset-0"
				style={STAGE_RAYS}
			/>
			<div className="relative flex items-end gap-6 max-sm:gap-3">
				<OpenSlot lead={false} />
				<OpenSlot lead />
				<OpenSlot lead={false} />
				<div
					aria-hidden="true"
					className="pointer-events-none absolute inset-x-[-20%] bottom-[-48px] h-24"
					style={STAGE_FLOOR}
				/>
			</div>
			<div className="relative flex max-w-xl flex-col items-center gap-4 text-center">
				<p className={cn(KICKER, "text-foreground/80")}>
					{tl("Squad 0/{size}", { size: size.toString() })}
				</p>
				<h2
					className={cn(
						DISPLAY,
						"text-[44px] text-foreground max-sm:text-[32px]"
					)}
					id="lobby-empty-title"
				>
					Your squad is empty
				</h2>
				<p className="max-w-md text-[15px] text-foreground/80 leading-6">
					Create an agent and it joins your squad here, with its threads as
					matches and quests.
				</p>
				<ChunkyButton
					className="mt-2"
					onClick={onStart}
					size="lg"
					tone="primary"
				>
					New thread
				</ChunkyButton>
			</div>
		</section>
	);
}
