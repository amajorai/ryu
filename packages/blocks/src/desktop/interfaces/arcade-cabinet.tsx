import { useLiteralMessages } from "@ryu/i18n/react";
import type { InterfaceAgent } from "@ryuhq/protocol/interfaces";
import { useRef } from "react";
import {
	DeckButton,
	Lever,
	PaylineMarker,
} from "./arcade-cabinet-controls.tsx";
import {
	CABINET_WIDTH,
	type Lamp,
	Marquee,
	Topper,
} from "./arcade-cabinet-lamps.tsx";
import { Meter, Tray } from "./arcade-cabinet-tray.tsx";
import { useRovingStops } from "./arcade-hooks.ts";
import {
	type Machine,
	machineSummary,
	spinningReels,
	threadTitle,
} from "./arcade-model.ts";
import { type ArcadePalette, cabinetSkin } from "./arcade-palette.ts";
import { ReelDrum } from "./arcade-reels.tsx";

export { CABINET_WIDTH, legibleSize } from "./arcade-cabinet-lamps.tsx";

/**
 * One slot machine, front on: a topper slot (JACKPOT while a reply waits
 * on you, chasing while it is fresh; IN PLAY while its ticket is open), a marquee with chase lights and
 * the agent's name, three reels for its latest conversations, the credit
 * and win meters, a button deck (Collect, Spin), the payout tray with a
 * ticket for every reply waiting on you, and a pull lever on the right.
 * Sizes are fixed pixels on a 4px grid; the floor zooms the whole bank.
 */

export function SlotCabinet({
	actLabel,
	active,
	activeThreadId,
	agents,
	blurId,
	composing,
	describedBy,
	feedback,
	machine,
	onCompose,
	onOpen,
	palette,
	reduced,
	zoom,
}: {
	/**
	 * The player's act sentence: with it the cabinet is named by the act and
	 * drops its legacy counters (the JACKPOT topper, Collect and the payout
	 * tickets), which count thread statuses the act layer replaces.
	 */
	actLabel?: string;
	/** This machine's ticket is open at the counter. */
	active: boolean;
	activeThreadId: string | null;
	/** Every agent, to name the others on a shared ticket. */
	agents: readonly InterfaceAgent[];
	blurId: string;
	/** The play slip is open for this machine. */
	composing: boolean;
	/** The id of the agent's act sentence (the act layer's row description). */
	describedBy?: string;
	/** A message just went in: every reel spins, then settles left to right. */
	feedback: boolean;
	machine: Machine;
	onCompose: () => void;
	onOpen: (threadId: string) => void;
	palette: ArcadePalette;
	reduced: boolean;
	/** The floor's zoom, so small print stays legible when the bank shrinks. */
	zoom: number;
}) {
	const tl = useLiteralMessages();
	const articleRef = useRef<HTMLElement>(null);
	const roving = useRovingStops(articleRef, "lever");
	const skin = cabinetSkin(palette.mode, machine.skin);
	const acted = actLabel !== undefined;
	const newest = acted ? undefined : machine.jackpots[0];
	const inPlay = active || composing;
	const spins = spinningReels(machine, feedback);
	const spinning = spins.includes(true);
	const won = !acted && machine.jackpots.length > 0;
	// One moving signal per cabinet: spinning reels win over a chase.
	const calm = reduced || spinning;
	const chasing = machine.hot && !calm && !inPlay;
	let lamp: Lamp = "dim";
	if (chasing) {
		lamp = "chase";
	} else if (inPlay || won) {
		lamp = "lit";
	}
	let topper: string | null = null;
	if (inPlay) {
		topper = "IN PLAY";
	} else if (won) {
		topper = "JACKPOT";
	}
	return (
		<article
			aria-label={actLabel ?? machineSummary(machine)}
			className="relative flex flex-col items-center"
			data-active={inPlay ? "" : undefined}
			data-arcade-machine={machine.id}
			data-composing={composing ? "" : undefined}
			data-hot={machine.hot ? "" : undefined}
			data-jackpot={won ? "" : undefined}
			data-spinning={spinning ? "" : undefined}
			data-tilt={machine.tilt ? "" : undefined}
			onFocus={roving.onFocus}
			onKeyDown={roving.onKeyDown}
			ref={articleRef}
			style={{ width: CABINET_WIDTH }}
		>
			<Topper blink={chasing} label={topper} palette={palette} />
			<Marquee lamp={lamp} machine={machine} mode={palette.mode} skin={skin} />
			<div
				className="relative flex w-full flex-col gap-2 p-3"
				style={{
					background: skin.body,
					borderLeft: `6px solid ${skin.shade}`,
					borderRight: `6px solid ${skin.shade}`,
					borderTop: `3px solid ${skin.trim}`,
				}}
			>
				<div
					className="relative flex items-center justify-between rounded-[6px] p-1.5"
					style={{
						background: skin.trim,
						boxShadow: `inset 0 2px 6px ${palette.floorShadow}`,
					}}
				>
					{machine.reels.map((reel, index) => (
						<ReelDrum
							acted={acted}
							active={reel.thread !== null && reel.thread.id === activeThreadId}
							blurId={blurId}
							describedBy={describedBy}
							index={index}
							// Reels are positional: left, centre, right.
							key={`reel-${index.toString()}`}
							onOpen={onOpen}
							palette={palette}
							reduced={reduced}
							reel={reel}
							spinning={spins[index] ?? false}
						/>
					))}
					<PaylineMarker palette={palette} side="left" />
					<PaylineMarker palette={palette} side="right" />
				</div>
				<Meter
					acted={acted}
					blink={!calm}
					machine={machine}
					palette={palette}
					zoom={zoom}
				/>
				<div className="flex items-center gap-2">
					{acted ? null : (
						<DeckButton
							disabled={!newest}
							label={
								newest
									? tl("Collect: open {title}", { title: threadTitle(newest) })
									: "Collect: no replies waiting"
							}
							lit={Boolean(newest)}
							onClick={() => {
								if (newest) {
									onOpen(newest.id);
								}
							}}
							palette={palette}
							skin={skin}
							stop="collect"
							zoom={zoom}
						>
							COLLECT
						</DeckButton>
					)}
					<DeckButton
						describedBy={describedBy}
						label={tl("Spin: message {name}", { name: machine.name })}
						lit={false}
						onClick={onCompose}
						palette={palette}
						skin={skin}
						stop="spin"
						wide
						zoom={zoom}
					>
						SPIN
					</DeckButton>
				</div>
				<Tray
					activeThreadId={activeThreadId}
					agents={agents}
					machine={acted ? { ...machine, jackpots: [] } : machine}
					onOpen={onOpen}
					palette={palette}
					zoom={zoom}
				/>
				<Lever
					describedBy={describedBy}
					machine={machine}
					onPull={onCompose}
					palette={palette}
					reduced={reduced}
				/>
			</div>
			<div
				aria-hidden="true"
				className="h-3 w-full rounded-b-[4px]"
				style={{
					background: skin.shade,
					boxShadow: `0 10px 14px -4px ${palette.floorShadow}`,
				}}
			/>
		</article>
	);
}
