import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import type { ReactNode, Ref } from "react";
import { BoardAvatar } from "./board-avatar.tsx";
import { GameSheet } from "./game-shell.tsx";
import type { PathStop, PathUnit } from "./path-model.ts";
import { stopMeta, stopMetaTone, stopTitle } from "./path-stop.tsx";

/**
 * The open thread in the game kit's side sheet: which unit it belongs to,
 * its title and state, and a close control, over the host's real
 * conversation surface.
 */
export function PathThreadPanel({
	headingRef,
	onClose,
	stop,
	threadView,
	unit,
}: {
	headingRef: Ref<HTMLHeadingElement>;
	onClose: () => void;
	stop: PathStop | undefined;
	threadView: ReactNode;
	unit: PathUnit | undefined;
}) {
	const tl = useLiteralMessages();
	const title = stop ? stopTitle(stop) : "New thread";
	const meta = stop ? stopMeta(stop) : "Not started";
	const lead = stop?.agents[0];
	return (
		<GameSheet
			closeLabel="Close thread"
			data-testid="path-thread-panel"
			headingRef={headingRef}
			label={tl("Thread: {title}", { title })}
			leading={
				lead ? (
					<BoardAvatar
						agent={lead}
						className="size-10 shrink-0 ring-(--gk-edge) ring-2"
						name={lead.name}
						size={28}
					/>
				) : undefined
			}
			onClose={onClose}
			sheetKey={stop?.thread.id ?? "new"}
			subtitle={
				<span className="truncate">
					<span
						className={cn(
							"font-semibold",
							stop ? stopMetaTone(stop.state) : undefined
						)}
					>
						{meta}
					</span>
					{unit
						? tl(" · Unit {index} · {title}", {
								index: String(unit.index),
								title: unit.title,
							})
						: ""}
				</span>
			}
			title={title}
		>
			<div className="min-h-0 flex-1">{threadView}</div>
		</GameSheet>
	);
}
