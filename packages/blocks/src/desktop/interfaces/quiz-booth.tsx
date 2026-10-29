import { useLiteralMessages } from "@ryu/i18n/react";
import type {
	InterfaceSnapshot,
	InterfaceThread,
} from "@ryuhq/protocol/interfaces";
import type { ReactNode, Ref } from "react";
import { GameSheet } from "./game-shell.tsx";
import { agentById } from "./interface-renderer.ts";
import { QuizAvatar } from "./quiz-avatar.tsx";
import { type QuizTile, threadTitle } from "./quiz-model.ts";

/**
 * The answer booth: the open conversation in the game kit's side sheet. The
 * header puts the contestant answering (avatar and name) with the clue's
 * category and value under the conversation title; the host's real
 * conversation surface fills the sheet. On a wide stage the board moves
 * left so the clue in play stays in sight; on a phone the sheet takes the
 * stage.
 */
export function QuizAnswerBooth({
	headingRef,
	onClose,
	snapshot,
	thread,
	threadView,
	tile,
}: {
	headingRef: Ref<HTMLHeadingElement>;
	onClose: () => void;
	snapshot: InterfaceSnapshot;
	thread: InterfaceThread | undefined;
	threadView: ReactNode;
	/** The board tile for this conversation, when it is on the board. */
	tile: QuizTile | undefined;
}) {
	const tl = useLiteralMessages();
	const title = thread ? threadTitle(thread) : "New conversation";
	const agent = agentById(snapshot, thread?.agentIds[0]);
	const category = tile?.categoryName;
	const lockup =
		[agent?.name, category === agent?.name ? undefined : category]
			.filter(Boolean)
			.join(" · ") || "Final question";
	return (
		<GameSheet
			closeLabel="Close answer booth"
			data-testid="quiz-answer-booth"
			headingRef={headingRef}
			label={tl("Answer booth: {title}", { title })}
			leading={
				agent ? (
					<QuizAvatar
						agent={agent}
						className="size-10 ring-(--gk-edge) ring-2"
					/>
				) : undefined
			}
			onClose={onClose}
			sheetKey={thread?.id ?? "new"}
			subtitle={
				<>
					<span className="truncate">{lockup}</span>
					{tile ? (
						<span className="gk-display shrink-0 rounded-md bg-(--gk-gold) px-1.5 text-(--gk-edge) text-[13px] tabular-nums leading-5">
							{tile.value}
						</span>
					) : null}
				</>
			}
			title={title}
		>
			<div className="min-h-0 flex-1 overflow-hidden">{threadView}</div>
		</GameSheet>
	);
}
