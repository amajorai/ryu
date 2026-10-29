import { useLiteralMessages } from "@ryu/i18n/react";
import {
	type InterfaceSnapshot,
	type InterfaceThread,
	THREAD_STATUS_LABELS,
	threadStatus,
} from "@ryuhq/protocol/interfaces";
import type { ReactNode, Ref } from "react";
import { GameSheet } from "./game-shell.tsx";
import { agentById } from "./interface-renderer.ts";
import { LobbyHead } from "./lobby-parts.tsx";

/**
 * The open conversation in the game kit's side sheet: who it is with and
 * where it stands, over the host's real conversation surface.
 */
export function LobbyThreadPanel({
	headingRef,
	onClose,
	snapshot,
	thread,
	threadView,
}: {
	headingRef: Ref<HTMLHeadingElement>;
	onClose: () => void;
	snapshot: InterfaceSnapshot;
	thread: InterfaceThread | undefined;
	threadView: ReactNode;
}) {
	const tl = useLiteralMessages();
	const title = thread
		? thread.title.trim() || "Untitled thread"
		: "New thread";
	const lead = agentById(snapshot, thread?.agentIds[0]);
	const others = Math.max(0, (thread?.agentIds.length ?? 0) - 1);
	const status = thread ? threadStatus(thread) : null;
	return (
		<GameSheet
			closeLabel="Close thread"
			data-testid="lobby-thread-panel"
			headingRef={headingRef}
			label={tl("Thread: {title}", { title })}
			leading={
				lead ? (
					<LobbyHead
						agent={lead}
						className="size-10 shadow-[0_0_0_2px_var(--gk-edge)]"
					/>
				) : undefined
			}
			onClose={onClose}
			sheetKey={thread?.id ?? "new"}
			subtitle={
				<span className="truncate">
					{lead ? lead.name : "No agent"}
					{others > 0 ? ` +${others}` : ""}
					{status ? ` · ${THREAD_STATUS_LABELS[status]}` : ""}
				</span>
			}
			title={title}
		>
			<div className="min-h-0 flex-1">{threadView}</div>
		</GameSheet>
	);
}
