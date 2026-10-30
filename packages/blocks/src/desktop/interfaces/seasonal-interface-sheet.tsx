import type { LiteralMessage } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import type {
	InterfacePort,
	InterfaceSnapshot,
	InterfaceThread,
} from "@ryuhq/protocol/interfaces";
import type { ReactNode } from "react";
import { GameSheet } from "./game-shell.tsx";
import { actSummaryLine, type actTotals } from "./game3d-acts.ts";
import { InterfaceComposer } from "./interface-composer.tsx";
import type { InterfaceRendererProps } from "./interface-renderer.ts";
import type { SidePanel } from "./seasonal-interface-constants.tsx";
import {
	boardSummary,
	plural,
	type SeasonBoard,
	type SeasonCopy,
	type SeasonDoor,
} from "./seasonal-model.ts";
import {
	ComposerPanel,
	DoorRow,
	GiftTag,
	GiftTagPanel,
	OverflowPanel,
} from "./seasonal-parts.tsx";

/** What the conversation list needs from the board. */
export interface SeasonalDoorListArgs {
	activeThreadId: string | null;
	actsOn: boolean;
	filledDoors: SeasonDoor[];
	labelOf: (door: SeasonDoor) => string;
	now: number;
	openThread: (threadId: string) => void;
	snapshot: InterfaceSnapshot;
	threadOpen: boolean;
}

/** The filled doors as a list, most urgent first. */
export function seasonalDoorList({
	activeThreadId,
	actsOn,
	filledDoors,
	labelOf,
	now,
	openThread,
	snapshot,
	threadOpen,
}: SeasonalDoorListArgs) {
	return (flush: boolean) => (
		<ul
			className={cn(
				"grid pb-2",
				flush
					? "@3xl/seasonal:grid-cols-2 @7xl/seasonal:grid-cols-3 grid-cols-1 gap-x-4"
					: "grid-cols-1"
			)}
		>
			{filledDoors.map((door) =>
				door.thread ? (
					<DoorRow
						active={door.thread.id === activeThreadId && threadOpen}
						acts={actsOn}
						actWords={door.actWords}
						flush={flush}
						key={door.thread.id}
						label={labelOf(door)}
						now={now}
						number={door.number}
						onOpen={() => {
							if (door.thread) {
								openThread(door.thread.id);
							}
						}}
						snapshot={snapshot}
						thread={door.thread}
					/>
				) : null
			)}
		</ul>
	);
}

/** What the side sheet needs from the board. */
export interface SeasonalSheetArgs {
	activeDoor: SeasonDoor | null;
	activeThread: InterfaceThread | null;
	activeThreadId: string | null;
	actsOn: boolean;
	board: SeasonBoard;
	closePanel: () => void;
	composeAgent: string | undefined;
	copy: SeasonCopy;
	doorList: (flush: boolean) => ReactNode;
	nextNumber: number | null;
	now: number;
	openThread: (threadId: string) => void;
	port: InterfacePort;
	setPickedAgent: (agentId: string | undefined) => void;
	setSide: (side: SidePanel) => void;
	side: SidePanel;
	snapshot: InterfaceSnapshot;
	threadOpen: boolean;
	threadView: InterfaceRendererProps<unknown>["threadView"];
	tl: LiteralMessage;
	totals: ReturnType<typeof actTotals>;
}

/** The sheet docked beside the board: a conversation, Add, More or All. */
export function seasonalSheet({
	activeDoor,
	activeThread,
	activeThreadId,
	actsOn,
	board,
	closePanel,
	composeAgent,
	copy,
	doorList,
	nextNumber,
	now,
	openThread,
	port,
	setPickedAgent,
	setSide,
	side,
	snapshot,
	threadOpen,
	threadView,
	tl,
	totals,
}: SeasonalSheetArgs): ReactNode {
	let sheet: ReactNode = null;
	if (threadOpen) {
		sheet = (
			<GameSheet
				closeLabel="Close conversation"
				data-seasonal-panel=""
				label="Conversation"
				leading={activeDoor ? <GiftTag number={activeDoor.number} /> : null}
				onClose={closePanel}
				sheetKey={activeThreadId ?? "thread"}
				title={activeThread?.title || "New conversation"}
			>
				<GiftTagPanel
					acts={actsOn}
					door={activeDoor}
					headless
					now={now}
					onClose={closePanel}
					snapshot={snapshot}
					stacked={false}
					thread={activeThread}
					threadView={threadView}
				/>
			</GameSheet>
		);
	} else if (side === "compose") {
		sheet = (
			<GameSheet
				closeLabel="Cancel"
				data-seasonal-panel=""
				label={copy.add}
				leading={nextNumber ? <GiftTag number={nextNumber} /> : null}
				onClose={() => setSide(null)}
				sheetKey="compose"
				title={copy.add}
			>
				<ComposerPanel
					agents={snapshot.agents}
					copy={copy}
					headless
					nextNumber={nextNumber}
					onClose={() => setSide(null)}
					onPick={setPickedAgent}
					picked={composeAgent}
					stacked={false}
				>
					<InterfaceComposer
						agents={snapshot.agents.length > 1 ? undefined : snapshot.agents}
						defaultAgentId={composeAgent}
						label={copy.add}
						onSubmit={({ agentId, prompt }) => {
							setSide(null);
							port.startThread({ agentId, prompt });
						}}
						placeholder="What should the agent work on?"
						submitLabel="Start"
					/>
				</ComposerPanel>
			</GameSheet>
		);
	} else if (side === "more") {
		sheet = (
			<GameSheet
				closeLabel={tl("Close {more}", { more: copy.more.toLowerCase() })}
				data-seasonal-panel=""
				label={copy.more}
				onClose={() => setSide(null)}
				sheetKey="more"
				subtitle={plural(
					board.overflow.length,
					"conversation",
					"conversations"
				)}
				title={copy.more}
			>
				<OverflowPanel
					activeThreadId={activeThreadId}
					acts={actsOn}
					copy={copy}
					headless
					now={now}
					onClose={() => setSide(null)}
					onOpen={openThread}
					snapshot={snapshot}
					stacked={false}
					threads={board.overflow}
				/>
			</GameSheet>
		);
	} else if (side === "all") {
		sheet = (
			<GameSheet
				closeLabel={tl("Close all {doors}", { doors: copy.doors })}
				data-seasonal-panel=""
				label={tl("All {doors}", { doors: copy.doors })}
				onClose={() => setSide(null)}
				sheetKey="all"
				subtitle={
					actsOn
						? `${plural(board.totals.threads, copy.door, copy.doors)} · ${actSummaryLine(totals)}`
						: boardSummary(board, copy)
				}
				title={tl("All {doors}", { doors: copy.doors })}
			>
				<div className="min-h-0 flex-1 overflow-y-auto">{doorList(false)}</div>
			</GameSheet>
		);
	}
	return sheet;
}
