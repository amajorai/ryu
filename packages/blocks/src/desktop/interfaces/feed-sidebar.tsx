import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	InputGroup,
	InputGroupAddon,
	InputGroupButton,
	InputGroupInput,
} from "@ryu/ui/components/input-group.tsx";
import { cn } from "@ryu/ui/lib/utils";
import type {
	FeedPost,
	InterfaceAgent,
	InterfaceSnapshot,
} from "@ryuhq/protocol/interfaces";
import { Search, X } from "lucide-react";
import { type ReactNode, type Ref, useId } from "react";
import {
	AuthorName,
	compactCount,
	FEED_FOCUS_INSET,
	FEED_META,
	FeedAvatar,
	feedAuthor,
} from "./feed-parts.tsx";
import { agentById } from "./interface-renderer.ts";

/** Pill search box that live-filters the timeline. */
export function FeedSearch({
	inputRef,
	onChange,
	query,
}: {
	inputRef?: Ref<HTMLInputElement>;
	onChange: (query: string) => void;
	query: string;
}) {
	const fieldId = useId();
	return (
		<div role="search">
			<label className="sr-only" htmlFor={fieldId}>
				Search posts
			</label>
			<InputGroup className="h-[42px] rounded-full border-border bg-muted/50 has-[[data-slot=input-group-control]:focus-visible]:border-primary has-[[data-slot=input-group-control]:focus-visible]:bg-background has-[[data-slot=input-group-control]:focus-visible]:ring-0">
				<InputGroupAddon className="ps-4">
					<Search
						aria-hidden="true"
						className="size-[18px] group-focus-within/input-group:text-primary"
						strokeWidth={2.25}
					/>
				</InputGroupAddon>
				<InputGroupInput
					autoComplete="off"
					className="h-full text-[15px] md:text-[15px] [&::-webkit-search-cancel-button]:appearance-none"
					id={fieldId}
					onChange={(event) => onChange(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Escape" && query) {
							event.preventDefault();
							onChange("");
						}
					}}
					placeholder="Search"
					ref={inputRef}
					type="search"
					value={query}
				/>
				{query ? (
					<InputGroupAddon align="inline-end">
						<InputGroupButton
							aria-label="Clear search"
							className="rounded-full bg-primary text-primary-foreground hover:bg-primary/80 hover:text-primary-foreground"
							onClick={() => onChange("")}
							size="icon-xs"
						>
							<X aria-hidden="true" className="size-3.5" strokeWidth={3} />
						</InputGroupButton>
					</InputGroupAddon>
				) : null}
			</InputGroup>
		</div>
	);
}

function SidebarCard({
	children,
	title,
}: {
	children: ReactNode;
	title: string;
}) {
	const headingId = useId();
	return (
		<section
			aria-labelledby={headingId}
			className="overflow-hidden rounded-2xl border border-transparent bg-muted/40 text-foreground dark:border-border dark:bg-background"
		>
			{/* `!`: the app shell's unlayered heading weight would otherwise win. */}
			<h2
				className="px-4 pt-3 pb-1 font-heading font-semibold! text-foreground text-xl leading-7"
				id={headingId}
			>
				{title}
			</h2>
			{children}
		</section>
	);
}

/** Running threads, listed like trending topics. */
export function WhatsHappening({
	onOpen,
	posts,
	snapshot,
}: {
	onOpen: (threadId: string) => void;
	posts: FeedPost[];
	snapshot: InterfaceSnapshot;
}) {
	const tl = useLiteralMessages();
	const running = posts.filter((post) => post.running);
	return (
		<SidebarCard title="What’s happening">
			{running.length === 0 ? (
				<p className={cn("px-4 pt-1 pb-4 text-[15px] leading-5", FEED_META)}>
					All quiet. Nothing is running right now.
				</p>
			) : (
				<ul className="pb-2">
					{running.map((post) => {
						const author = feedAuthor(agentById(snapshot, post.authorAgentId));
						return (
							<li key={post.threadId}>
								<button
									className={cn(
										"flex w-full flex-col px-4 py-3 text-left transition-colors hover:bg-muted/60",
										FEED_FOCUS_INSET
									)}
									onClick={() => onOpen(post.threadId)}
									type="button"
								>
									<span
										className={cn("truncate text-[13px] leading-4", FEED_META)}
									>
										{tl("{name} · Working", { name: author.name })}
									</span>
									<span className="mt-0.5 line-clamp-2 font-medium text-[15px] text-foreground leading-5">
										{post.title || "Untitled"}
									</span>
									<span
										className={cn("mt-0.5 text-[13px] leading-4", FEED_META)}
									>
										{compactCount(post.replyCount)}{" "}
										{post.replyCount === 1 ? "reply" : "replies"}
									</span>
								</button>
							</li>
						);
					})}
				</ul>
			)}
		</SidebarCard>
	);
}

/** One agent row with a "Message" pill, the way a follow suggestion looks. */
export function AgentRow({
	agent,
	bio = false,
	onMessage,
	tone = "card",
}: {
	agent: InterfaceAgent;
	bio?: boolean;
	onMessage: () => void;
	tone?: "card" | "timeline";
}) {
	const tl = useLiteralMessages();
	const author = feedAuthor(agent);
	return (
		<li
			className={cn(
				"flex gap-3 px-4 py-3 transition-colors",
				tone === "card"
					? "hover:bg-muted/60"
					: "border-border border-b hover:bg-muted/50"
			)}
		>
			<FeedAvatar author={author} working={agent.status === "working"} />
			<div className="flex min-w-0 flex-1 flex-col">
				<div className="flex items-center gap-3">
					<div className="flex min-w-0 flex-1 flex-col text-[15px] leading-5">
						<AuthorName author={author} />
						<span
							className={cn("flex min-w-0 items-center gap-x-1", FEED_META)}
						>
							<span className="min-w-0 truncate">{author.handle}</span>
							{agent.status === "working" ? (
								// The sidebar card shows the avatar's dot alone; the
								// agents page spells the state out beside the handle.
								<span
									className={cn(
										"flex shrink-0 items-center gap-1 text-foreground",
										tone === "card" && "sr-only"
									)}
								>
									<span aria-hidden="true" className={FEED_META}>
										·
									</span>
									Working
								</span>
							) : null}
						</span>
					</div>
					{/* X's follow pill: the same filled pill wherever an agent is listed. */}
					<Button
						aria-label={tl("Message {name}", { name: agent.name })}
						className="rounded-full border-transparent bg-foreground px-4 font-semibold text-background hover:bg-foreground/85"
						onClick={onMessage}
						size="sm"
						type="button"
					>
						Message
					</Button>
				</div>
				{bio && agent.description ? (
					<p className="mt-1 text-[15px] text-foreground leading-5">
						{agent.description}
					</p>
				) : null}
			</div>
		</li>
	);
}

/** Agents to message, working ones first. */
export function sortAgents(agents: InterfaceAgent[]): InterfaceAgent[] {
	return [...agents].sort(
		(a, b) =>
			Number(b.status === "working") - Number(a.status === "working") ||
			a.name.localeCompare(b.name)
	);
}

export function AgentsCard({
	agents,
	onMessage,
	onShowAll,
}: {
	agents: InterfaceAgent[];
	onMessage: (agentId: string) => void;
	onShowAll: () => void;
}) {
	if (agents.length === 0) {
		return null;
	}
	return (
		<SidebarCard title="Agents">
			<ul>
				{sortAgents(agents)
					.slice(0, 3)
					.map((agent) => (
						<AgentRow
							agent={agent}
							key={agent.id}
							onMessage={() => onMessage(agent.id)}
						/>
					))}
			</ul>
			<button
				className={cn(
					"w-full px-4 py-4 text-left text-[15px] text-primary leading-5 transition-colors hover:bg-muted/60",
					FEED_FOCUS_INSET
				)}
				onClick={onShowAll}
				type="button"
			>
				Show all agents
			</button>
		</SidebarCard>
	);
}
