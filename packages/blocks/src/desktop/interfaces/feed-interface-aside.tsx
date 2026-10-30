import { cn } from "@ryu/ui/lib/utils";
import type {
	FeedPost,
	InterfacePort,
	InterfaceSnapshot,
} from "@ryuhq/protocol/interfaces";
import type { FeedView } from "./feed-nav.tsx";
import { FEED_SCROLLBAR } from "./feed-parts.tsx";
import { AgentsCard, FeedSearch, WhatsHappening } from "./feed-sidebar.tsx";

/** The right-hand column: search, what's happening, and who to message. */
export function FeedAside({
	messageAgent,
	port,
	posts,
	query,
	selectView,
	setQuery,
	snapshot,
	view,
}: {
	messageAgent: (agentId: string) => void;
	port: InterfacePort;
	posts: FeedPost[];
	query: string;
	selectView: (next: FeedView) => void;
	setQuery: (query: string) => void;
	snapshot: InterfaceSnapshot;
	view: FeedView;
}) {
	return (
		<aside
			aria-label="Search and trends"
			className="@min-[1080px]:ml-[30px] ml-6 @min-[1000px]:flex hidden h-full @min-[1080px]:w-[350px] w-[290px] shrink-0 flex-col @max-[1079px]:pr-4"
		>
			{/* The search box stays put; the cards scroll beneath it. */}
			<div className="flex h-[53px] shrink-0 items-center">
				<div className="w-full">
					<FeedSearch onChange={setQuery} query={query} />
				</div>
			</div>
			{/*
			 * Native scrolling rather than @ryu/ui ScrollArea: Base UI's
			 * viewport calls getAnimations() on a timer, which the unit-test
			 * DOM lacks, so every feed test would log uncaught errors. The
			 * scrollbar still takes the theme's border colour.
			 */}
			<div
				className={cn(
					"min-h-0 flex-1 overflow-y-auto overscroll-contain",
					FEED_SCROLLBAR
				)}
			>
				<div className="flex flex-col gap-4 pt-[11px] pb-16">
					<WhatsHappening
						onOpen={(threadId) => port.openThread(threadId)}
						posts={posts}
						snapshot={snapshot}
					/>
					{/* The Agents page already lists everyone; X hides "Who to follow" there too. */}
					{view === "agents" ? null : (
						<AgentsCard
							agents={snapshot.agents}
							onMessage={messageAgent}
							onShowAll={() => selectView("agents")}
						/>
					)}
				</div>
			</div>
		</aside>
	);
}
