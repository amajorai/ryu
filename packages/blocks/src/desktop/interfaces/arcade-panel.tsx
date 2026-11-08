import { useLiteralMessages } from "@ryu/i18n/react";
import { type InterfaceThread, threadStatus } from "@ryuhq/protocol/interfaces";
import type { ReactNode, Ref } from "react";
import { type Machine, machineSummary, threadTitle } from "./arcade-model.ts";
import { BoardStatusDot } from "./board-status.tsx";
import { GameSheet } from "./game-shell.tsx";
import { relativeAge, threadStatusLabel } from "./interface-renderer.ts";
import { newConversationLabel } from "./thread-display-title.ts";

/**
 * The redemption counter: the host's own conversation surface in the game
 * kit's side sheet, headed by the ticket it was cashed from (status,
 * machine, credits, last activity).
 */
export function ArcadePanel({
	headingRef,
	machine,
	onClose,
	showAge = true,
	thread,
	threadView,
}: {
	headingRef: Ref<HTMLHeadingElement>;
	machine: Machine | undefined;
	onClose: () => void;
	/**
	 * Show how long ago the conversation last changed. Off with the act
	 * layer, whose times come only from the acts (never `updatedAt`).
	 */
	showAge?: boolean;
	thread: InterfaceThread | undefined;
	threadView: ReactNode;
}) {
	const title = thread ? threadTitle(thread) : newConversationLabel();
	const status = thread ? threadStatus(thread) : null;
	const age = thread && showAge ? relativeAge(thread.updatedAt) : "";
	const tl = useLiteralMessages();
	return (
		<GameSheet
			closeLabel="Close ticket"
			data-testid="arcade-panel"
			eyebrow="Redemption counter"
			headingRef={headingRef}
			label={tl("Redemption counter: {title}", { title })}
			onClose={onClose}
			sheetKey={thread?.id ?? "new"}
			subtitle={
				<>
					{status && showAge ? (
						<>
							<BoardStatusDot status={status} />
							<span className="shrink-0">{threadStatusLabel(status)}</span>
							<span aria-hidden="true">·</span>
						</>
					) : null}
					<span className="truncate">
						{machine
							? tl("{machineName} machine", { machineName: machine.name })
							: "Starting"}
					</span>
					{thread ? (
						<>
							<span aria-hidden="true">·</span>
							<span className="shrink-0 tabular-nums">
								{tl("{count, plural, one {# credit} other {# credits}}", {
									count: thread.messageCount,
								})}
							</span>
						</>
					) : null}
					{age ? (
						<>
							<span aria-hidden="true">·</span>
							<time
								className="shrink-0 tabular-nums"
								dateTime={thread?.updatedAt}
							>
								{age}
							</time>
						</>
					) : null}
				</>
			}
			title={title}
		>
			<div className="flex min-h-0 flex-1 flex-col">{threadView}</div>
		</GameSheet>
	);
}

/**
 * A machine up close: the slot cabinet (reels, collect, spin, payout and
 * lever, all working) in the side sheet, opened from its player in the hall.
 */
export function MachineSheet({
	children,
	headingRef,
	machine,
	onClose,
	summary,
}: {
	children: ReactNode;
	headingRef: Ref<HTMLHeadingElement>;
	machine: Machine;
	onClose: () => void;
	/** The player's act sentence, in place of the legacy machine summary. */
	summary?: string;
}) {
	const tl = useLiteralMessages();
	return (
		<GameSheet
			closeLabel="Close machine"
			data-testid="arcade-machine-sheet"
			eyebrow="Slot machine"
			headingRef={headingRef}
			label={tl("Machine: {machineName}", { machineName: machine.name })}
			onClose={onClose}
			sheetKey={machine.id}
			subtitle={
				<span className="truncate">
					{summary ?? machineSummary(machine, tl)}
				</span>
			}
			title={machine.name}
		>
			<div className="flex min-h-0 flex-1 justify-center overflow-y-auto p-4">
				{children}
			</div>
		</GameSheet>
	);
}
