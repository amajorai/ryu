import { useLiteralMessages } from "@ryu/i18n/react";
import type {
	InterfaceAgentAct,
	InterfaceAsk,
	InterfaceSnapshot,
} from "@ryuhq/protocol/interfaces";
import { plus } from "./game3d-act-stage-geometry.ts";
import type { OffStage, YouSlot, YouSpotSlot } from "./game3d-acts.ts";
import type { LifeItem } from "./game3d-life.ts";
import { ActInk } from "./game3d-materials.tsx";
import { WaitTimer3D, type WaitTimerShape } from "./game3d-meters.tsx";
import type { Vec3 } from "./game3d-palette.ts";
import {
	NoticePost,
	offStageLabel,
	offStageText,
	overflowLabel,
	TallyPlate,
	TrayItem,
} from "./game3d-signs.tsx";
import { useStageQuality } from "./game3d-stage.tsx";

/** The longest headline a delivered item's tag shows. */
const HEADLINE_TAG_CHARS = 32;

/**
 * The headline tag for a delivering act's item: its thread's last turn
 * headline ("Edited 3 files, ran 2 commands"), cut to HEADLINE_TAG_CHARS;
 * null when there is none or the snapshot is redacted (never invented).
 */
export function trayHeadline(
	act: InterfaceAgentAct,
	snapshot: InterfaceSnapshot
): string | null {
	if (snapshot.privacy === "redacted") {
		return null;
	}
	const headline = snapshot.threads
		.find((thread) => thread.id === act.threadId)
		?.outcome?.headline?.trim();
	if (!headline) {
		return null;
	}
	return headline.length > HEADLINE_TAG_CHARS
		? `${headline.slice(0, HEADLINE_TAG_CHARS - 1).trimEnd()}…`
		: headline;
}

/** Where the you-spot pieces sit. */
export interface YouSpotLayout {
	/** The off-stage agents' tally. */
	offStage: Vec3;
	/** Each queue point. */
	slots: Record<YouSlot, Vec3>;
	/** The "+N more" tally. */
	tally: Vec3;
	/** A queued villager's wait timer, as an offset from its slot (default [0.55, 0, 0.2]). */
	timer?: Vec3;
	/**
	 * The first tray item; the rest step along `trayStep`, at most
	 * `trayMax` to a row, further rows stepping along `trayRowStep`, so a
	 * busy tray stays in its own corner and never reaches the slots.
	 */
	tray: Vec3;
	/** Default 3. */
	trayMax?: number;
	/** Default [0, 0, -0.7]: away from the queue. */
	trayRowStep?: Vec3;
	/** Default [0.7, 0, 0]. */
	trayStep?: Vec3;
}

/** Where `count` tray items sit, wrapping every `trayMax` (see `YouSpotLayout.tray`). */
export function trayPositions(
	layout: Pick<YouSpotLayout, "tray" | "trayMax" | "trayRowStep" | "trayStep">,
	count: number
): Vec3[] {
	const step = layout.trayStep ?? [0.7, 0, 0];
	const rowStep = layout.trayRowStep ?? [0, 0, -0.7];
	const perRow = Math.max(1, Math.floor(layout.trayMax ?? 3));
	return Array.from({ length: count }, (_, index) => {
		const column = index % perRow;
		const row = Math.floor(index / perRow);
		return [
			layout.tray[0] + step[0] * column + rowStep[0] * row,
			layout.tray[1] + step[1] * column + rowStep[1] * row,
			layout.tray[2] + step[2] * column + rowStep[2] * row,
		];
	});
}

/** A game's look for the queue's wait timers (a shot clock, a fence post...). */
export interface TimerSkin {
	/** The timer's frame colour. */
	color?: string;
	/** The timer prop (default the hourglass; "candle" melts). */
	shape?: WaitTimerShape;
}

/** The you-spot queue, its tallies and the delivery tray. */
export function YouSpots({
	focusable = true,
	iconOnly,
	item,
	layout,
	nowMs,
	offStage,
	onAsk,
	onOpenQueue,
	onStage,
	owners,
	privacy = "full",
	reduced,
	shown,
	slots,
	snapshot,
	timerSkin,
	trayTag,
}: {
	focusable?: boolean;
	/** The overlay budget's `iconOnly`. */
	iconOnly: boolean;
	/** The game's deliverable (`ActSkin.deliverable`). */
	item: LifeItem;
	layout: YouSpotLayout;
	nowMs: number;
	offStage: OffStage;
	onAsk: (askId: string) => void;
	/** Opens the Queue sheet (`openQueue(openRef)`). */
	onOpenQueue: () => void;
	/** On-stage acts (`stageAgents(...).onStage`): delivering ones fill the tray. */
	onStage: readonly InterfaceAgentAct[];
	/** `askOwners(acts)`: who a notice's ask belongs to. */
	owners: ReadonlyMap<string, string>;
	privacy?: "full" | "redacted";
	reduced: boolean;
	shown: ReadonlySet<string>;
	/** `youSpotSlots(acts, unowned, onStageIds)`. */
	slots: { overflow: number; slots: readonly YouSpotSlot[] };
	snapshot: InterfaceSnapshot;
	timerSkin?: TimerSkin;
	/**
	 * "headline": each delivered item carries a tag with its answer's
	 * headline ("Edited 3 files"), when the snapshot has one (never under
	 * redaction). Default: no tag.
	 */
	trayTag?: "headline";
}) {
	const timer = layout.timer ?? [0.55, 0, 0.2];
	const delivering = onStage.filter(
		(act) => act.act === "delivering" && act.ask
	);
	const trays = trayPositions(layout, delivering.length);
	const quality = useStageQuality();
	const tl = useLiteralMessages();
	return (
		<ActInk on={quality !== "low"}>
			<group>
				{slots.slots.map((slot) => {
					const at = layout.slots[slot.point];
					if (slot.carrier === "notice") {
						return (
							<NoticePost
								ask={slot.ask}
								at={at}
								focusable={focusable}
								key={slot.ask.id}
								nowMs={nowMs}
								onOpen={onAsk}
								ownerName={owners.get(slot.ask.id) ?? null}
								privacy={privacy}
								reducedMotion={reduced}
							/>
						);
					}
					return (
						<WaitTimer3D
							at={plus([at[0], 0, at[2]], timer)}
							color={timerSkin?.color}
							key={slot.ask.id}
							nowMs={nowMs}
							reducedMotion={reduced}
							shape={timerSkin?.shape}
							timer={{
								approx: slot.ask.sinceApprox,
								since: slot.ask.since,
								until: slot.ask.expiresAt ?? null,
								untilApprox: slot.ask.expiresApprox,
							}}
						/>
					);
				})}
				{slots.overflow > 0 && shown.has("tally:you") ? (
					<TallyPlate
						at={layout.tally}
						focusable={focusable}
						label={overflowLabel(slots.overflow)}
						onOpen={onOpenQueue}
						scope="you"
						text={tl("+{overflow} more", { overflow: String(slots.overflow) })}
					/>
				) : null}
				{offStage.count > 0 && shown.has("tally:off") ? (
					<TallyPlate
						at={layout.offStage}
						focusable={focusable}
						label={offStageLabel(offStage.count)}
						onOpen={onOpenQueue}
						scope="off"
						text={offStageText(offStage)}
					/>
				) : null}
				{delivering.map((act, index) => (
					<TrayItem
						ask={act.ask as InterfaceAsk}
						at={trays[index] ?? layout.tray}
						count={
							snapshot.threads.find((thread) => thread.id === act.threadId)
								?.outcome?.filesChanged ?? null
						}
						focusable={focusable}
						iconOnly={iconOnly}
						item={item}
						key={act.agentId}
						nowMs={nowMs}
						onOpen={onAsk}
						ownerName={act.agentName}
						privacy={privacy}
						reducedMotion={reduced}
						showCount={shown.has(`count:${act.agentId}`)}
						tag={trayTag === "headline" ? trayHeadline(act, snapshot) : null}
					/>
				))}
			</group>
		</ActInk>
	);
}
