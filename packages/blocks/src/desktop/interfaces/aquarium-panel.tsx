import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import {
	type InterfaceSnapshot,
	type InterfaceThread,
	THREAD_STATUS_LABELS,
	threadStatus,
} from "@ryuhq/protocol/interfaces";
import { Inbox } from "lucide-react";
import { type ReactNode, type Ref, useContext } from "react";
import { CREATURE_LABELS, type Creature } from "./aquarium-model.ts";
import { creatureHue, type TankPalette } from "./aquarium-palette.ts";
import {
	AquariumPanelActs,
	STATUS_TONE,
	threadTitle,
} from "./aquarium-panel-context.ts";
import { AgentBody, UnassignedBody } from "./aquarium-panel-threads.tsx";
import { CreaturePortrait, CreatureStatusMark } from "./aquarium-parts.tsx";
import { BoardStatusDot } from "./board-status.tsx";
import { GameSheet } from "./game-shell.tsx";
import { InterfaceComposer } from "./interface-composer.tsx";

export { AquariumPanelActs } from "./aquarium-panel-context.ts";

export type AquariumPanelView =
	| { creature: Creature; kind: "agent" }
	| { kind: "unassigned" }
	| {
			creature: Creature | undefined;
			kind: "thread";
			thread: InterfaceThread | undefined;
	  };

/**
 * The side panel beside the tank, in the game kit's sheet. Three views: an agent's
 * card (who they are, their threads by status, and a composer that messages
 * them), the threads no agent is on, and the open thread, which is the host's
 * own conversation surface with a way back to the agent it was opened from.
 */
export function AquariumPanel({
	activeThreadId,
	headingRef,
	id,
	now,
	onBack,
	onClose,
	onMessage,
	onOpen,
	palette,
	snapshot,
	threadView,
	view,
}: {
	activeThreadId: string | null;
	/** Focus lands here when the panel opens or changes view. */
	headingRef: Ref<HTMLHeadingElement>;
	id: string;
	now: number;
	onBack: () => void;
	onClose: () => void;
	onMessage: (agentId: string, prompt: string) => void;
	onOpen: (threadId: string) => void;
	palette: TankPalette;
	snapshot: InterfaceSnapshot;
	threadView: ReactNode;
	view: AquariumPanelView;
}) {
	const actMode = useContext(AquariumPanelActs) !== null;
	const tl = useLiteralMessages();
	if (view.kind === "thread") {
		const { creature, thread } = view;
		const status = thread ? threadStatus(thread) : null;
		const back = creature ? `Back to ${creature.name}` : "Back to the reef";
		return (
			<GameSheet
				backLabel={back}
				closeLabel="Close thread"
				data-testid="aquarium-panel"
				data-view="thread"
				headingRef={headingRef}
				id={id}
				label={tl("Thread: {title}", { title: threadTitle(thread) })}
				leading={
					creature ? (
						<CreaturePortrait
							creature={creature}
							eye={palette.eye}
							hue={creatureHue(palette, creature.colorIndex)}
							size={36}
						/>
					) : null
				}
				onBack={onBack}
				onClose={onClose}
				sheetKey={`thread:${thread?.id ?? "new"}`}
				subtitle={
					<>
						<span className="truncate">
							{creature ? creature.name : "No agent"}
						</span>
						{status && !actMode ? (
							<>
								<span aria-hidden="true">·</span>
								<span
									className={cn(
										"inline-flex shrink-0 items-center gap-1.5",
										STATUS_TONE[status]
									)}
								>
									<BoardStatusDot className="size-1.5" status={status} />
									{THREAD_STATUS_LABELS[status]}
								</span>
							</>
						) : null}
					</>
				}
				title={threadTitle(thread)}
			>
				<div className="min-h-0 flex-1">{threadView}</div>
			</GameSheet>
		);
	}
	if (view.kind === "agent") {
		const { creature } = view;
		return (
			<GameSheet
				closeLabel="Close panel"
				data-testid="aquarium-panel"
				data-view="agent"
				footer={
					<div data-aquarium-composer="">
						<InterfaceComposer
							label={tl("Message {name}", { name: creature.agent.name })}
							onSubmit={({ prompt }) => onMessage(creature.agent.id, prompt)}
							placeholder={tl("Message {name}…", { name: creature.agent.name })}
						/>
					</div>
				}
				headingRef={headingRef}
				id={id}
				label={creature.name}
				leading={
					<CreaturePortrait
						creature={creature}
						eye={palette.eye}
						hue={creatureHue(palette, creature.colorIndex)}
						size={44}
					/>
				}
				onClose={onClose}
				sheetKey={`agent:${creature.id}`}
				subtitle={
					<>
						{actMode ? null : (
							<>
								<CreatureStatusMark working={creature.working} />
								<span className={cn(creature.working && "text-status-success")}>
									{creature.working ? "Working" : "Idle"}
								</span>
								<span aria-hidden="true">·</span>
							</>
						)}
						<span className="truncate">{CREATURE_LABELS[creature.kind]}</span>
					</>
				}
				title={creature.agent.name}
			>
				<AgentBody
					activeThreadId={activeThreadId}
					creature={creature}
					now={now}
					onOpen={onOpen}
					snapshot={snapshot}
				/>
			</GameSheet>
		);
	}
	const unassigned = snapshot.threads.filter(
		(thread) => thread.agentIds.length === 0
	);
	return (
		<GameSheet
			closeLabel="Close panel"
			data-testid="aquarium-panel"
			data-view="unassigned"
			headingRef={headingRef}
			id={id}
			label="Unassigned threads"
			leading={
				<span
					aria-hidden="true"
					className="grid size-9 place-items-center rounded-xl border-(--gk-edge) border-2 bg-(--gk-warn) text-(--gk-edge)"
				>
					<Inbox className="size-4" strokeWidth={2.5} />
				</span>
			}
			onClose={onClose}
			sheetKey="unassigned"
			subtitle={tl(
				"{count, plural, one {{countText} thread} other {{countText} threads}} no agent is on",
				{ count: unassigned.length, countText: String(unassigned.length) }
			)}
			title="Unassigned threads"
		>
			<UnassignedBody
				activeThreadId={activeThreadId}
				now={now}
				onOpen={onOpen}
				snapshot={snapshot}
				threads={unassigned}
			/>
		</GameSheet>
	);
}
