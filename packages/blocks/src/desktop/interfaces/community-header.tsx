import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { ditherAvatarHue } from "@ryu/ui/components/dither-kit/avatar.tsx";
import { DitherGradient } from "@ryu/ui/components/dither-kit/gradient.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@ryu/ui/components/dropdown-menu.tsx";
import { cn } from "@ryu/ui/lib/utils";
import {
	ChevronDown,
	Menu,
	MessageSquare,
	Plus,
	Search,
	X,
} from "lucide-react";
import type { KeyboardEvent, Ref } from "react";
import { type Community, communityLabel, plural } from "./community-model.ts";
import { AgentFace, CommunityIcon } from "./community-parts.tsx";

export interface TopBarProps {
	navOpen: boolean;
	onCreate: () => void;
	onQueryChange: (query: string) => void;
	onSubmitSearch: () => void;
	onToggleNav: () => void;
	query: string;
	searchRef: Ref<HTMLInputElement>;
}

/**
 * Reddit's header: a centred search field and a Create button. The menu
 * button only shows once the left rail folds away.
 */
export function TopBar({
	navOpen,
	onCreate,
	onQueryChange,
	onSubmitSearch,
	onToggleNav,
	query,
	searchRef,
}: TopBarProps) {
	const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
		if (event.key === "Escape" && query) {
			event.preventDefault();
			event.stopPropagation();
			onQueryChange("");
		} else if (event.key === "Enter") {
			event.preventDefault();
			onSubmitSearch();
		}
	};
	return (
		<header className="grid h-14 shrink-0 grid-cols-[1fr_minmax(0,560px)_1fr] items-center gap-3 border-border border-b px-4">
			<div className="flex items-center">
				<Button
					aria-expanded={navOpen}
					aria-label={navOpen ? "Close navigation" : "Open navigation"}
					className="@[860px]/community:hidden"
					onClick={onToggleNav}
					size="icon"
					variant="ghost"
				>
					<Menu aria-hidden="true" className="size-5" strokeWidth={1.75} />
				</Button>
			</div>
			<div className="relative flex items-center" role="search">
				<Search
					aria-hidden="true"
					className="pointer-events-none absolute left-4 size-4 text-muted-foreground"
					strokeWidth={2}
				/>
				<input
					aria-label="Search posts and communities"
					className="h-10 w-full rounded-full border border-transparent bg-secondary pr-10 pl-11 text-foreground text-sm outline-none transition-colors duration-100 placeholder:text-muted-foreground hover:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_5%)] focus-visible:border-ring focus-visible:bg-background focus-visible:ring-3 focus-visible:ring-ring/30"
					onChange={(event) => onQueryChange(event.target.value)}
					onKeyDown={onKeyDown}
					placeholder="Search Community"
					ref={searchRef}
					type="search"
					value={query}
				/>
				{query ? (
					<button
						aria-label="Clear search"
						className="absolute right-2 flex size-7 items-center justify-center rounded-full text-muted-foreground outline-none transition-colors duration-100 hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
						onClick={() => onQueryChange("")}
						type="button"
					>
						<X aria-hidden="true" className="size-4" strokeWidth={2} />
					</button>
				) : null}
			</div>
			<div className="flex items-center justify-end">
				<Button
					aria-label="Create post"
					onClick={onCreate}
					size="default"
					variant="ghost"
				>
					<Plus
						aria-hidden="true"
						className="size-5"
						data-icon="inline-start"
						strokeWidth={1.75}
					/>
					<span className="@[640px]/community:inline hidden">Create</span>
				</Button>
			</div>
		</header>
	);
}

/** The banner strip: Ryu's dither art in the community icon's own hue. */
function Banner({ community }: { community: Community }) {
	const seed =
		community.kind === "agent"
			? (community.members[0]?.name ?? community.seed)
			: community.seed;
	return (
		<div
			aria-hidden="true"
			className="relative @[640px]/community:h-32 h-20 overflow-hidden rounded-lg bg-muted"
			data-testid="community-banner"
		>
			{community.kind === "profile" ? null : (
				<DitherGradient
					cell={6}
					className="opacity-40"
					direction="right"
					from={ditherAvatarHue(seed)}
				/>
			)}
		</div>
	);
}

export interface MessageButtonProps {
	community: Community;
	onMessage: (agentId: string) => void;
}

/**
 * Starts a new thread with one of the community's agents. One member sends
 * straight away; several open a menu to pick who.
 */
function MessageButton({ community, onMessage }: MessageButtonProps) {
	const tl = useLiteralMessages();
	const { members } = community;
	const [only] = members;
	if (!only) {
		return null;
	}
	if (members.length === 1) {
		return (
			<Button
				aria-label={tl("Message {name}", { name: only.name })}
				onClick={() => onMessage(only.id)}
				size="sm"
			>
				<MessageSquare
					aria-hidden="true"
					data-icon="inline-start"
					strokeWidth={1.75}
				/>
				Message
			</Button>
		);
	}
	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				render={
					<Button aria-label="Message an agent" size="sm">
						<MessageSquare
							aria-hidden="true"
							data-icon="inline-start"
							strokeWidth={1.75}
						/>
						Message
						<ChevronDown
							aria-hidden="true"
							data-icon="inline-end"
							strokeWidth={1.75}
						/>
					</Button>
				}
			/>
			<DropdownMenuContent
				align="end"
				className="w-60"
				drawerLabel="Message an agent"
			>
				{members.map((agent) => (
					<DropdownMenuItem
						className="gap-2"
						key={agent.id}
						onClick={() => onMessage(agent.id)}
					>
						<AgentFace
							agent={agent}
							ring="ring-popover"
							showWorking
							size={24}
						/>
						<span className="truncate">{agent.name}</span>
					</DropdownMenuItem>
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

export interface CommunityHeaderProps {
	community: Community;
	headingId: string;
	onCreate: () => void;
	onMessage: (agentId: string) => void;
}

/**
 * The top of a community page, in Reddit's shape: banner, an icon that
 * overlaps it, the name, and Create Post / Message on the right.
 */
export function CommunityHeader({
	community,
	headingId,
	onCreate,
	onMessage,
}: CommunityHeaderProps) {
	return (
		<header className="flex flex-col" data-testid="community-header">
			<Banner community={community} />
			<div className="flex flex-wrap items-end gap-x-4 gap-y-3 px-4">
				<CommunityIcon
					className={cn(
						"-mt-8 @[640px]/community:-mt-10 rounded-full ring-4 ring-background"
					)}
					community={community}
					size={80}
				/>
				<div className="flex min-w-0 flex-1 flex-col pb-1">
					<h1
						className="truncate font-bold! @[640px]/community:text-3xl text-2xl text-foreground @[640px]/community:leading-9 leading-8 tracking-tight"
						id={headingId}
					>
						{communityLabel(community)}
					</h1>
					<p className="truncate text-muted-foreground text-sm leading-5">
						{community.name} · {plural(community.threadCount, "thread")}
					</p>
				</div>
				<div className="flex items-center gap-2 pb-1">
					<Button onClick={onCreate} size="sm" variant="outline">
						<Plus
							aria-hidden="true"
							data-icon="inline-start"
							strokeWidth={1.75}
						/>
						Create Post
					</Button>
					<MessageButton community={community} onMessage={onMessage} />
				</div>
			</div>
		</header>
	);
}
