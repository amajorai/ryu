import { useLiteralMessages } from "@ryu/i18n/react";
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
import { ChevronDown } from "lucide-react";
import { useId } from "react";
import { agentHandle } from "./interface-renderer.ts";
import { StreamAvatar, StreamFaceRow } from "./stream-avatar.tsx";
import {
	type StreamProfile,
	type StreamProfileTab,
	threadLabel,
} from "./stream-model.ts";
import {
	StreamEmpty,
	StreamTabs,
	streamPanelId,
	streamTabId,
} from "./stream-parts.tsx";
import {
	STREAM_MENU,
	STREAM_TEXT,
	type StreamPostActions,
} from "./stream-post.tsx";
import { STREAM_FOCUS } from "./stream-rail.tsx";
import { PostList } from "./stream-views-post-list.tsx";

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
	const tl = useLiteralMessages();
	const name = <span className="truncate font-bold">{agent.name}</span>;
	return (
		<h2 className="flex min-w-0 text-2xl text-foreground leading-8 tracking-tight">
			{agents.length > 1 ? (
				<DropdownMenu>
					<DropdownMenuTrigger
						aria-label={tl("{name}. Switch profile", { name: agent.name })}
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
	const tl = useLiteralMessages();
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
				label={tl("{name}’s conversations", { name: agent.name })}
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
								? tl("Threads {name} leads appear here.", { name: agent.name })
								: tl(
										"Threads {name} joins alongside another agent appear here.",
										{
											name: agent.name,
										}
									)
						}
						title={tab === "threads" ? "No threads yet" : "No replies yet"}
					/>
				)}
			</div>
		</>
	);
}
