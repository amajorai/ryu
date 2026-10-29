import { useLiteralMessages } from "@ryu/i18n/react";
import {
	Avatar,
	AvatarFallback,
	AvatarImage,
} from "@ryu/ui/components/avatar.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { DitherAvatar } from "@ryu/ui/components/dither-kit/avatar.tsx";
import { Skeleton } from "@ryu/ui/components/skeleton.tsx";
import { cn } from "@ryu/ui/lib/utils";
import type { InterfaceAgent } from "@ryuhq/protocol/interfaces";
import { ArrowBigDown, ArrowBigUp, UserRound } from "lucide-react";
import type { ReactNode } from "react";
import {
	type Community,
	type CommunityPost,
	type CommunityVote,
	communityLabel,
	flairLabel,
	shortCount,
} from "./community-model.ts";

export type CommunityIconSize = 20 | 24 | 32 | 40 | 80;

const ICON_SIZE: Record<CommunityIconSize, string> = {
	20: "size-5",
	24: "size-6",
	32: "size-8",
	40: "size-10",
	80: "size-20",
};

/** Dot size for an agent's working mark, by icon size. */
const DOT_SIZE: Record<CommunityIconSize, string> = {
	20: "size-2 ring-[1.5px]",
	24: "size-2 ring-2",
	32: "size-2.5 ring-2",
	40: "size-3 ring-2",
	80: "size-4 ring-4",
};

/**
 * The user's own avatar: a person glyph on a muted disc. Decorative; the
 * text beside it always says "you".
 */
function ProfileIcon({
	className,
	size,
}: {
	className?: string;
	size: CommunityIconSize;
}) {
	return (
		<span
			aria-hidden="true"
			className={cn(
				"flex shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground",
				ICON_SIZE[size],
				className
			)}
		>
			<UserRound className="size-[58%]" strokeWidth={2} />
		</span>
	);
}

/**
 * An agent's face: its picture, or Ryu's dither tile seeded by name. Agents
 * with a live run carry a small online-style dot, the way Reddit marks
 * someone who is online.
 */
export function AgentFace({
	agent,
	className,
	ring = "ring-background",
	showWorking = false,
	size,
}: {
	agent: InterfaceAgent | null;
	className?: string;
	/** Ring color for the working dot, matching the surface behind it. */
	ring?: string;
	showWorking?: boolean;
	size: CommunityIconSize;
}) {
	if (!agent) {
		return <ProfileIcon className={className} size={size} />;
	}
	return (
		<span
			aria-hidden="true"
			className={cn("relative flex shrink-0", ICON_SIZE[size], className)}
		>
			<Avatar className="size-full">
				{agent.avatarUrl ? <AvatarImage alt="" src={agent.avatarUrl} /> : null}
				<AvatarFallback
					appearance="artwork"
					className="overflow-hidden bg-muted"
				>
					<DitherAvatar
						animate={false}
						className="size-full"
						name={agent.name}
					/>
				</AvatarFallback>
			</Avatar>
			{showWorking && agent.status === "working" ? (
				<span
					className={cn(
						"absolute right-0 bottom-0 rounded-full bg-success",
						DOT_SIZE[size],
						ring
					)}
				/>
			) : null}
		</span>
	);
}

/**
 * A community's round icon. Agent communities use the agent's face; projects
 * and teams get a dither tile from the same seed as their banner.
 */
export function CommunityIcon({
	className,
	community,
	ring,
	showWorking = false,
	size,
}: {
	className?: string;
	community: Community;
	ring?: string;
	showWorking?: boolean;
	size: CommunityIconSize;
}) {
	if (community.kind === "profile") {
		return <ProfileIcon className={className} size={size} />;
	}
	if (community.kind === "agent") {
		return (
			<AgentFace
				agent={community.members[0] ?? null}
				className={className}
				ring={ring}
				showWorking={showWorking}
				size={size}
			/>
		);
	}
	return (
		<span
			aria-hidden="true"
			className={cn(
				"relative flex shrink-0 overflow-hidden rounded-full bg-muted",
				ICON_SIZE[size],
				className
			)}
		>
			<DitherAvatar
				animate={false}
				className="size-full"
				name={community.seed}
			/>
		</span>
	);
}

const FLAIR_TONE: Record<CommunityPost["status"], string> = {
	attention: "bg-destructive/10 text-status-destructive",
	quiet: "bg-muted text-foreground/75",
	waiting: "bg-muted text-foreground/75",
	working: "bg-success/12 text-status-success",
	"your-turn": "bg-primary/10 text-primary",
};

/** Post flair: one small pill that says where the thread stands. */
export function PostFlair({ post }: { post: CommunityPost }) {
	return (
		<span
			className={cn(
				"inline-flex h-5 shrink-0 items-center gap-1.5 rounded-full px-2 font-medium text-xs leading-none",
				FLAIR_TONE[post.status]
			)}
			data-status={post.status}
		>
			{post.status === "working" ? (
				<span
					aria-hidden="true"
					className="size-1.5 rounded-full bg-success motion-safe:animate-pulse"
				/>
			) : null}
			{flairLabel(post)}
		</span>
	);
}

/** A quiet inline link in a meta row: community or poster. */
export function MetaLink({
	children,
	className,
	label,
	onClick,
}: {
	children: ReactNode;
	className?: string;
	label: string;
	onClick: () => void;
}) {
	return (
		<button
			aria-label={label}
			className={cn(
				"relative z-10 min-w-0 truncate rounded-sm outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/50",
				className
			)}
			onClick={onClick}
			type="button"
		>
			{children}
		</button>
	);
}

/** Separator dot for meta rows. */
export function MetaDot() {
	return (
		<span aria-hidden="true" className="text-muted-foreground">
			·
		</span>
	);
}

/** The community link as it sits in a post's meta row. */
export function CommunityLink({
	community,
	onSelect,
	showIcon = true,
}: {
	community: Community;
	onSelect: (community: Community) => void;
	showIcon?: boolean;
}) {
	const tl = useLiteralMessages();
	return (
		<span className="flex min-w-0 shrink-0 items-center gap-2">
			{showIcon ? <CommunityIcon community={community} size={24} /> : null}
			<MetaLink
				className="font-semibold text-foreground"
				label={tl("Open {community}", {
					community: communityLabel(community),
				})}
				onClick={() => onSelect(community)}
			>
				{communityLabel(community)}
			</MetaLink>
		</span>
	);
}

/** Neutral pill surface shared by every action in a post's action row. */
export const ACTION_PILL =
	"relative z-10 inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full bg-secondary px-3 font-semibold text-secondary-foreground text-xs tabular-nums outline-none transition-colors duration-100 hover:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_8%)] focus-visible:ring-2 focus-visible:ring-ring/50 active:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_14%)] [&_svg]:size-4 [&_svg]:shrink-0";

export interface VoteProps {
	onVote: (vote: CommunityVote) => void;
	score: number;
	title: string;
	vote: CommunityVote | undefined;
}

function voteLabel(direction: "Downvote" | "Upvote", title: string) {
	return `${direction} “${title}”`;
}

/**
 * Reddit's vote pill: up arrow, score, down arrow. An upvote fills the pill
 * with the theme's primary color; a downvote inverts it.
 */
export function VotePill({ onVote, score, title, vote }: VoteProps) {
	const arrow =
		"flex size-8 items-center justify-center rounded-full outline-none transition-colors duration-100 focus-visible:ring-2 focus-visible:ring-ring/50";
	return (
		<span
			className={cn(
				"relative z-10 inline-flex h-8 shrink-0 items-center rounded-full font-semibold text-xs tabular-nums transition-colors duration-100",
				vote === undefined && "bg-secondary text-secondary-foreground",
				vote === 1 && "bg-primary text-primary-foreground",
				vote === -1 && "bg-foreground text-background"
			)}
			data-vote={vote ?? 0}
		>
			<button
				aria-label={voteLabel("Upvote", title)}
				aria-pressed={vote === 1}
				className={cn(
					arrow,
					vote === undefined
						? "hover:bg-foreground/8 hover:text-primary"
						: "hover:bg-background/15"
				)}
				onClick={() => onVote(1)}
				type="button"
			>
				<ArrowBigUp
					aria-hidden="true"
					className="size-5"
					fill={vote === 1 ? "currentColor" : "none"}
					strokeWidth={1.5}
				/>
			</button>
			<span className="min-w-4 text-center">
				<span className="sr-only">Score </span>
				{shortCount(score)}
			</span>
			<button
				aria-label={voteLabel("Downvote", title)}
				aria-pressed={vote === -1}
				className={cn(
					arrow,
					vote === undefined
						? "hover:bg-foreground/8 hover:text-foreground"
						: "hover:bg-background/15"
				)}
				onClick={() => onVote(-1)}
				type="button"
			>
				<ArrowBigDown
					aria-hidden="true"
					className="size-5"
					fill={vote === -1 ? "currentColor" : "none"}
					strokeWidth={1.5}
				/>
			</button>
		</span>
	);
}

/** The compact view's vertical vote column. */
export function VoteColumn({ onVote, score, title, vote }: VoteProps) {
	const arrow =
		"flex size-5 items-center justify-center rounded-sm text-muted-foreground outline-none transition-colors duration-100 hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50";
	return (
		<span
			className="relative z-10 flex w-10 shrink-0 flex-col items-center"
			data-vote={vote ?? 0}
		>
			<button
				aria-label={voteLabel("Upvote", title)}
				aria-pressed={vote === 1}
				className={cn(
					arrow,
					"hover:text-primary",
					vote === 1 && "text-primary"
				)}
				onClick={() => onVote(1)}
				type="button"
			>
				<ArrowBigUp
					aria-hidden="true"
					className="size-4"
					fill={vote === 1 ? "currentColor" : "none"}
					strokeWidth={1.5}
				/>
			</button>
			<span
				className={cn(
					"font-semibold text-foreground text-xs tabular-nums leading-4",
					vote === 1 && "text-primary"
				)}
			>
				<span className="sr-only">Score </span>
				{shortCount(score)}
			</span>
			<button
				aria-label={voteLabel("Downvote", title)}
				aria-pressed={vote === -1}
				className={cn(
					arrow,
					"hover:text-foreground",
					vote === -1 && "text-foreground"
				)}
				onClick={() => onVote(-1)}
				type="button"
			>
				<ArrowBigDown
					aria-hidden="true"
					className="size-4"
					fill={vote === -1 ? "currentColor" : "none"}
					strokeWidth={1.5}
				/>
			</button>
		</span>
	);
}

/** Feed placeholder in the card view's real rhythm. */
export function FeedSkeleton() {
	return (
		<div aria-label="Loading posts" className="flex flex-col" role="status">
			{["one", "two", "three", "four"].map((key, index) => (
				<div className="flex flex-col" key={key}>
					{index > 0 ? <hr className="my-1 border-border" /> : null}
					<div className="flex flex-col gap-2 px-4 py-3">
						<div className="flex items-center gap-2">
							<Skeleton className="size-6 rounded-full" />
							<Skeleton className="h-3 w-40" radius="dense" />
						</div>
						<Skeleton className="h-5 w-3/5" radius="dense" />
						<Skeleton className="h-4 w-full" radius="dense" />
						<Skeleton className="h-4 w-4/5" radius="dense" />
						<div className="mt-1 flex gap-2">
							<Skeleton className="h-8 w-24 rounded-full" />
							<Skeleton className="h-8 w-16 rounded-full" />
							<Skeleton className="h-8 w-20 rounded-full" />
						</div>
					</div>
				</div>
			))}
			<span className="sr-only">Loading posts</span>
		</div>
	);
}

/** A plain empty state: what is missing, why, and one way forward. */
export function CommunityEmpty({
	action,
	body,
	title,
}: {
	action?: { label: string; onClick: () => void } | null;
	body: string;
	title: string;
}) {
	return (
		<div
			className="flex flex-col items-center px-4 py-16 text-center"
			data-testid="community-empty"
		>
			<h2 className="font-semibold! text-base text-foreground">{title}</h2>
			<p className="mt-1 max-w-[44ch] text-muted-foreground text-sm leading-6">
				{body}
			</p>
			{action ? (
				<Button className="mt-4" onClick={action.onClick} size="sm">
					{action.label}
				</Button>
			) : null}
		</div>
	);
}
