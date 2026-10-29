import { Button } from "@ryu/ui/components/button.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuTrigger,
} from "@ryu/ui/components/dropdown-menu.tsx";
import { cn } from "@ryu/ui/lib/utils";
import type { InterfaceAgent } from "@ryuhq/protocol/interfaces";
import { ChevronDown, MessageCircle, Search, X } from "lucide-react";
import { type Ref, useId } from "react";
import { agentHandle, compactAge } from "./interface-renderer.ts";
import { StreamAvatar, StreamFaceRow } from "./stream-avatar.tsx";
import {
	activityPosts,
	activityVerb,
	type StreamActivityFilter,
	type StreamPost,
	type StreamProfile,
	type StreamProfileTab,
	searchStream,
	threadLabel,
} from "./stream-model.ts";
import {
	StreamChips,
	StreamEmpty,
	StreamTabs,
	streamPanelId,
	streamTabId,
} from "./stream-parts.tsx";
import {
	STREAM_MENU,
	STREAM_TEXT,
	type StreamPostActions,
	StreamPostItem,
} from "./stream-post.tsx";
import { STREAM_FOCUS } from "./stream-rail.tsx";

function PostList({
	actions,
	posts,
}: {
	actions: StreamPostActions;
	posts: StreamPost[];
}) {
	return (
		<ul className="flex flex-col">
			{posts.map((post) => (
				<li key={post.threadId}>
					<StreamPostItem actions={actions} post={post} />
				</li>
			))}
		</ul>
	);
}

// ---------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------

const ACTIVITY_FILTERS: { label: string; value: StreamActivityFilter }[] = [
	{ label: "All", value: "all" },
	{ label: "Replies", value: "replies" },
	{ label: "Failed", value: "failed" },
];

/** The small mark on the avatar's corner saying what kind of activity it is. */
function ActivityBadge({ failed }: { failed: boolean }) {
	const Icon = failed ? X : MessageCircle;
	return (
		<span
			aria-hidden="true"
			className={cn(
				"absolute -right-1 -bottom-1 flex size-[18px] items-center justify-center rounded-full ring-2 ring-card",
				failed
					? "bg-destructive text-background"
					: "bg-foreground text-background"
			)}
		>
			<Icon className="size-2.5" strokeWidth={3} />
		</span>
	);
}

function ActivityRow({
	onOpen,
	post,
}: {
	onOpen: (threadId: string) => void;
	post: StreamPost;
}) {
	const name = post.author?.name ?? "You";
	const failed = post.status === "attention";
	return (
		<li>
			<button
				className={cn(
					"group flex w-full gap-3 px-6 pt-3 text-left transition-colors duration-150 hover:bg-muted/50",
					STREAM_FOCUS,
					"focus-visible:ring-inset focus-visible:ring-offset-0"
				)}
				onClick={() => onOpen(post.threadId)}
				type="button"
			>
				<span className="relative h-fit shrink-0">
					<StreamAvatar agent={post.author} name={name} size={36} />
					<ActivityBadge failed={failed} />
				</span>
				<span
					className={cn(
						"flex min-w-0 flex-1 flex-col border-border border-b pb-3",
						STREAM_TEXT
					)}
				>
					<span className="flex items-center gap-1.5">
						<span className="truncate font-semibold text-foreground">
							{name}
						</span>
						<time
							className="shrink-0 text-muted-foreground"
							dateTime={post.updatedAt}
						>
							{compactAge(post.updatedAt)}
						</time>
					</span>
					<span className="truncate text-muted-foreground">
						{activityVerb(post)}{" "}
						<span className={failed ? "text-destructive" : "text-foreground"}>
							{post.title}
						</span>
					</span>
					{post.body ? (
						<span className="mt-1 line-clamp-2 text-foreground">
							{post.body}
						</span>
					) : null}
				</span>
			</button>
		</li>
	);
}

export function StreamActivityView({
	filter,
	onFilter,
	onOpen,
	posts,
}: {
	filter: StreamActivityFilter;
	onFilter: (filter: StreamActivityFilter) => void;
	onOpen: (threadId: string) => void;
	posts: StreamPost[];
}) {
	const shown = activityPosts(posts, filter);
	return (
		<>
			<StreamChips
				label="Filter activity"
				onChange={onFilter}
				options={ACTIVITY_FILTERS.map((option) => ({
					...option,
					count: activityPosts(posts, option.value).length,
				}))}
				value={filter}
			/>
			{shown.length > 0 ? (
				<ul aria-label="Waiting on you" className="flex flex-col">
					{shown.map((post) => (
						<ActivityRow key={post.threadId} onOpen={onOpen} post={post} />
					))}
				</ul>
			) : (
				<StreamEmpty
					description={
						filter === "failed"
							? "Every run finished cleanly."
							: "When an agent replies or a run fails, it shows up here."
					}
					title="Nothing waiting on you"
				/>
			)}
		</>
	);
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

function AgentRow({
	agent,
	count,
	onMessage,
	onProfile,
}: {
	agent: InterfaceAgent;
	count: number;
	onMessage: (agentId: string) => void;
	onProfile: (agentId: string) => void;
}) {
	return (
		<li className="flex gap-3 px-6 pt-4">
			<button
				aria-label={`View ${agent.name}’s profile`}
				className={cn("h-fit rounded-full", STREAM_FOCUS)}
				onClick={() => onProfile(agent.id)}
				tabIndex={-1}
				type="button"
			>
				<StreamAvatar agent={agent} name={agent.name} size={36} />
			</button>
			<div
				className={cn(
					"flex min-w-0 flex-1 items-start gap-3 border-border border-b pb-4",
					STREAM_TEXT
				)}
			>
				<div className="flex min-w-0 flex-1 flex-col">
					<button
						className={cn(
							"w-fit max-w-full truncate rounded-sm text-left font-semibold text-foreground hover:underline",
							STREAM_FOCUS
						)}
						onClick={() => onProfile(agent.id)}
						type="button"
					>
						{agent.name}
					</button>
					<span className="truncate text-muted-foreground">
						{agent.description || agentHandle(agent.name)}
					</span>
					<span className="mt-1.5 flex items-center gap-1.5 text-foreground">
						{agent.status === "working" ? (
							<>
								<span
									aria-hidden="true"
									className="size-1.5 rounded-full bg-success"
								/>
								Working ·{" "}
							</>
						) : null}
						{threadLabel(count)}
					</span>
				</div>
				<Button
					className="h-9 shrink-0 rounded-xl px-5 font-semibold text-[15px]"
					onClick={() => onMessage(agent.id)}
					variant="outline"
				>
					Message
				</Button>
			</div>
		</li>
	);
}

export function StreamSearchView({
	actions,
	agents,
	counts,
	inputRef,
	onQuery,
	posts,
	query,
}: {
	actions: StreamPostActions;
	agents: InterfaceAgent[];
	counts: Map<string, number>;
	inputRef: Ref<HTMLInputElement>;
	onQuery: (query: string) => void;
	posts: StreamPost[];
	query: string;
}) {
	const result = searchStream(agents, posts, query);
	const searching = query.trim().length > 0;
	const nothing =
		searching && result.agents.length === 0 && result.posts.length === 0;
	return (
		<>
			<div className="px-6 pt-4 pb-1">
				<div className="flex h-11 items-center gap-2 rounded-2xl border border-border bg-background px-4 transition-colors duration-150 focus-within:border-ring">
					<Search
						aria-hidden="true"
						className="size-4 shrink-0 text-muted-foreground"
						strokeWidth={2}
					/>
					<input
						aria-label="Search agents and threads"
						className={cn(
							"min-w-0 flex-1 bg-transparent text-foreground outline-none placeholder:text-muted-foreground",
							STREAM_TEXT
						)}
						onChange={(event) => onQuery(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === "Escape" && query) {
								event.preventDefault();
								onQuery("");
							}
						}}
						placeholder="Search"
						ref={inputRef}
						type="search"
						value={query}
					/>
					{query ? (
						<button
							aria-label="Clear search"
							className={cn(
								"-mr-1.5 flex size-6 items-center justify-center rounded-full bg-muted text-muted-foreground hover:text-foreground",
								STREAM_FOCUS
							)}
							onClick={() => onQuery("")}
							type="button"
						>
							<X aria-hidden="true" className="size-3.5" strokeWidth={2.25} />
						</button>
					) : null}
				</div>
			</div>
			{nothing ? (
				<StreamEmpty
					description="Try an agent’s name, a thread title or a project."
					title={`No results for “${query.trim()}”`}
				/>
			) : null}
			{result.agents.length > 0 ? (
				<section aria-label={searching ? "Agents" : "Your agents"}>
					<h2 className="px-6 pt-4 text-muted-foreground text-sm">
						<span className="font-semibold">
							{searching ? "Agents" : "Your agents"}
						</span>
					</h2>
					<ul>
						{result.agents.map((agent) => (
							<AgentRow
								agent={agent}
								count={counts.get(agent.id) ?? 0}
								key={agent.id}
								onMessage={actions.onNewThread}
								onProfile={actions.onProfile}
							/>
						))}
					</ul>
				</section>
			) : null}
			{result.posts.length > 0 ? (
				<section aria-label="Threads">
					<h2 className="px-6 pt-5 pb-1 text-muted-foreground text-sm">
						<span className="font-semibold">Threads</span>
					</h2>
					<PostList actions={actions} posts={result.posts} />
				</section>
			) : null}
			{!searching && agents.length === 0 ? (
				<StreamEmpty
					description="Agents you add appear here, ready to message."
					title="No agents yet"
				/>
			) : null}
		</>
	);
}

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

const PROFILE_TABS: { label: string; value: StreamProfileTab }[] = [
	{ label: "Threads", value: "threads" },
	{ label: "Replies", value: "replies" },
];

function ProfileMeta({ profile }: { profile: StreamProfile }) {
	const groups = profile.groups.map((group) => group.name).join(", ");
	return (
		<div
			className={cn(
				"mt-4 flex min-w-0 items-center gap-2 text-muted-foreground",
				STREAM_TEXT
			)}
		>
			<StreamFaceRow agents={profile.teammates} />
			<span className="truncate">
				{groups || threadLabel(profile.threads.length)}
			</span>
		</div>
	);
}

/** The big name, which doubles as the switch to any other agent's profile. */
function ProfileName({
	agent,
	agents,
	onProfile,
}: {
	agent: InterfaceAgent;
	agents: InterfaceAgent[];
	onProfile: (agentId: string) => void;
}) {
	const name = <span className="truncate font-bold">{agent.name}</span>;
	return (
		<h2 className="flex min-w-0 text-2xl text-foreground leading-8 tracking-tight">
			{agents.length > 1 ? (
				<DropdownMenu>
					<DropdownMenuTrigger
						aria-label={`${agent.name}. Switch profile`}
						className={cn(
							"-mx-1 flex min-w-0 items-center gap-1 rounded-lg px-1 transition-colors duration-150 hover:bg-muted data-[popup-open]:bg-muted",
							STREAM_FOCUS
						)}
					>
						{name}
						<ChevronDown
							aria-hidden="true"
							className="mt-0.5 size-5 shrink-0 text-muted-foreground"
							strokeWidth={2}
						/>
					</DropdownMenuTrigger>
					<DropdownMenuContent
						align="start"
						className={cn("w-64", STREAM_MENU)}
						drawerLabel="Switch profile"
					>
						<DropdownMenuRadioGroup
							onValueChange={(value: unknown) => {
								if (typeof value === "string") {
									onProfile(value);
								}
							}}
							value={agent.id}
						>
							<DropdownMenuLabel>Switch profile</DropdownMenuLabel>
							{agents.map((item) => (
								<DropdownMenuRadioItem
									className="gap-2"
									closeOnClick
									key={item.id}
									value={item.id}
								>
									<StreamAvatar agent={item} name={item.name} size={20} />
									<span className="truncate">{item.name}</span>
								</DropdownMenuRadioItem>
							))}
						</DropdownMenuRadioGroup>
					</DropdownMenuContent>
				</DropdownMenu>
			) : (
				name
			)}
		</h2>
	);
}

export function StreamProfileView({
	actions,
	agents,
	onTab,
	profile,
	tab,
}: {
	actions: StreamPostActions;
	agents: InterfaceAgent[];
	onTab: (tab: StreamProfileTab) => void;
	profile: StreamProfile;
	tab: StreamProfileTab;
}) {
	const tabsId = useId();
	const { agent } = profile;
	const posts = tab === "threads" ? profile.threads : profile.replies;
	return (
		<>
			<div className="px-6 pt-6 pb-5">
				<div className="flex items-center gap-4">
					<div className="min-w-0 flex-1">
						<ProfileName
							agent={agent}
							agents={agents}
							onProfile={actions.onProfile}
						/>
						<p
							className={cn(
								"mt-0.5 flex min-w-0 items-center gap-1.5 text-muted-foreground",
								STREAM_TEXT
							)}
						>
							<span className="truncate text-foreground">
								{agentHandle(agent.name)}
							</span>
							{agent.status === "working" ? (
								<>
									<span aria-hidden="true">·</span>
									<span
										aria-hidden="true"
										className="size-1.5 shrink-0 rounded-full bg-success"
									/>
									<span className="shrink-0">Working</span>
								</>
							) : null}
						</p>
					</div>
					<StreamAvatar agent={agent} name={agent.name} size={84} />
				</div>
				{agent.description ? (
					<p className={cn("mt-4 text-foreground", STREAM_TEXT)}>
						{agent.description}
					</p>
				) : null}
				<ProfileMeta profile={profile} />
				<Button
					className="mt-5 h-9 w-full rounded-xl font-semibold text-[15px]"
					onClick={() => actions.onNewThread(agent.id)}
					variant="mono"
				>
					Message
				</Button>
			</div>
			<StreamTabs
				baseId={tabsId}
				label={`${agent.name}’s conversations`}
				onChange={onTab}
				options={PROFILE_TABS}
				value={tab}
			/>
			<div
				aria-labelledby={streamTabId(tabsId, tab)}
				id={streamPanelId(tabsId)}
				role="tabpanel"
			>
				{posts.length > 0 ? (
					<PostList actions={actions} posts={posts} />
				) : (
					<StreamEmpty
						description={
							tab === "threads"
								? `Threads ${agent.name} leads appear here.`
								: `Threads ${agent.name} joins alongside another agent appear here.`
						}
						title={tab === "threads" ? "No threads yet" : "No replies yet"}
					/>
				)}
			</div>
		</>
	);
}
