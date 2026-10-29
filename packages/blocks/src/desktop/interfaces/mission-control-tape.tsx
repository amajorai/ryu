import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import type { InterfaceSnapshot } from "@ryuhq/protocol/interfaces";
import { agentById } from "./interface-renderer.ts";
import { type MissionTapeItem, shortTime } from "./mission-control-model.ts";
import {
	Lamp,
	type LampState,
	SUBTLE_LABEL,
} from "./mission-control-parts.tsx";

const MARK_LAMP: Record<MissionTapeItem["mark"], LampState> = {
	attention: "alert",
	failure: "failure",
	quiet: "idle",
	success: "success",
	waiting: "waiting",
	working: "working",
	"your-turn": "your-turn",
};

function TapeEntry({
	item,
	onOpen,
	snapshot,
}: {
	item: MissionTapeItem;
	onOpen: (threadId: string) => void;
	snapshot: InterfaceSnapshot;
}) {
	const tl = useLiteralMessages();
	const agent = agentById(snapshot, item.agentId);
	const content = (
		<>
			<span className="text-muted-foreground tabular-nums">
				{shortTime(item.at)}
			</span>
			<Lamp size="sm" state={MARK_LAMP[item.mark]} />
			{agent ? (
				<span className="font-medium text-foreground">{agent.name}</span>
			) : null}
			<span className="text-foreground">{item.title}</span>
			{item.detail ? (
				<span className="max-w-[28ch] truncate text-muted-foreground">
					{item.detail}
				</span>
			) : null}
		</>
	);
	const threadId = item.threadId;
	return (
		<li
			className="group/tape flex shrink-0 items-center"
			data-tape-item={item.id}
		>
			{threadId ? (
				<button
					aria-label={tl("Open {title}, updated {updatedAt}", {
						title: item.title,
						updatedAt: shortTime(item.at),
					})}
					className="flex h-7 items-center gap-2 whitespace-nowrap rounded-md px-2 text-xs outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
					onClick={() => onOpen(threadId)}
					type="button"
				>
					{content}
				</button>
			) : (
				<span className="flex h-7 items-center gap-2 whitespace-nowrap px-2 text-xs">
					{content}
				</span>
			)}
			<span
				aria-hidden="true"
				className="mx-1 h-3 w-px shrink-0 bg-border group-last/tape:hidden"
			/>
		</li>
	);
}

/**
 * A slim strip of the latest updates along the bottom of the wall, newest
 * first from the left. It holds still; when it outgrows the wall it scrolls
 * sideways by hand (trackpad, Shift-wheel, or Tab through its entries).
 */
export function EventTape({
	items,
	onOpen,
	snapshot,
}: {
	items: MissionTapeItem[];
	onOpen: (threadId: string) => void;
	snapshot: InterfaceSnapshot;
}) {
	return (
		<section
			aria-label="Latest updates"
			className="flex h-9 shrink-0 items-center border-border border-t bg-card"
		>
			<span
				className={cn(
					"flex h-full shrink-0 items-center gap-2 border-border border-r px-3",
					SUBTLE_LABEL
				)}
			>
				Latest
			</span>
			{items.length === 0 ? (
				<p className="px-3 text-muted-foreground text-xs">
					Updates appear here as agents work.
				</p>
			) : (
				<ul className="flex h-full min-w-0 flex-1 items-center overflow-x-auto overscroll-x-contain px-1 [scrollbar-width:none]">
					{items.map((item) => (
						<TapeEntry
							item={item}
							key={item.id}
							onOpen={onOpen}
							snapshot={snapshot}
						/>
					))}
				</ul>
			)}
		</section>
	);
}
