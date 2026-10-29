import { useLiteralMessages } from "@ryu/i18n/react";
import {
	Avatar,
	AvatarFallback,
	AvatarImage,
} from "@ryu/ui/components/avatar.tsx";
import {
	DitherAvatar,
	ditherAvatarSeed,
} from "@ryu/ui/components/dither-kit/avatar.tsx";
import { cn } from "@ryu/ui/lib/utils";
import type { InterfaceAgent } from "@ryuhq/protocol/interfaces";
import { UserRound } from "lucide-react";
import type { CSSProperties } from "react";
import { BoardStatusDot } from "./board-status.tsx";
import {
	type ForumCategory,
	type ForumTopic,
	swatchColor,
	topicStatusNote,
} from "./forum-model.ts";

/** Quiet square icon button used across the forum chrome. */
export const ICON_BUTTON =
	"inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors duration-100 hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-40";

/** Inline text button: a link-like control inside running text or tables. */
export const TEXT_BUTTON =
	"rounded-sm text-left outline-none underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring/50";

export type ForumAvatarSize = 16 | 20 | 24 | 40;

const AVATAR_SIZE: Record<ForumAvatarSize, string> = {
	16: "size-4",
	20: "size-5",
	24: "size-6",
	40: "size-10",
};

const YOU_ICON_SIZE: Record<ForumAvatarSize, string> = {
	16: "size-2.5",
	20: "size-3",
	24: "size-3.5",
	40: "size-5",
};

/**
 * An agent's picture or Ryu's generative dither tile (seeded by id so it
 * survives renames); with no agent, the neutral silhouette that stands for
 * you. Decorative: the surrounding row or post names the author.
 */
export function ForumAvatar({
	agent,
	className,
	size,
}: {
	agent: InterfaceAgent | null;
	className?: string;
	size: ForumAvatarSize;
}) {
	if (!agent) {
		return (
			<span
				aria-hidden="true"
				className={cn(
					"inline-flex shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground",
					AVATAR_SIZE[size],
					className
				)}
			>
				<UserRound className={YOU_ICON_SIZE[size]} strokeWidth={2} />
			</span>
		);
	}
	const seed = ditherAvatarSeed({ id: agent.id, name: agent.name });
	return (
		<Avatar aria-hidden="true" className={cn(AVATAR_SIZE[size], className)}>
			{agent.avatarUrl ? <AvatarImage alt="" src={agent.avatarUrl} /> : null}
			<AvatarFallback appearance="artwork" className="overflow-hidden bg-muted">
				<DitherAvatar animate={false} className="size-full" name={seed} />
			</AvatarFallback>
		</Avatar>
	);
}

/** The category's colour square. */
export function CategorySwatch({
	category,
	className,
}: {
	category: Pick<ForumCategory, "swatch">;
	className?: string;
}) {
	return (
		<span
			aria-hidden="true"
			className={cn(
				"inline-block size-2.5 shrink-0 rounded-[2px] bg-(--forum-swatch)",
				className
			)}
			style={
				{ "--forum-swatch": swatchColor(category.swatch) } as CSSProperties
			}
		/>
	);
}

/**
 * Discourse's bullet-style category badge: a colour square and the name.
 * A button when it can take the reader to the category.
 */
export function CategoryBadge({
	category,
	className,
	onSelect,
}: {
	category: ForumCategory;
	className?: string;
	onSelect?: (categoryId: string) => void;
}) {
	const tl = useLiteralMessages();
	const content = (
		<>
			<CategorySwatch category={category} />
			<span className="truncate">{category.name}</span>
		</>
	);
	const base = cn(
		"inline-flex min-w-0 max-w-full items-center gap-1.5 text-muted-foreground text-xs leading-4",
		className
	);
	if (!onSelect) {
		return <span className={base}>{content}</span>;
	}
	return (
		<button
			aria-label={tl("Category: {name}", { name: category.name })}
			className={cn(
				base,
				"relative z-10 rounded-sm outline-none transition-colors duration-100 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
			)}
			onClick={(event) => {
				event.stopPropagation();
				onSelect(category.id);
			}}
			type="button"
		>
			{content}
		</button>
	);
}

const POSTER_LIMIT = 5;

/**
 * Discourse's posters column: side-by-side faces, original poster first. A
 * topic nobody but you has written in shows your silhouette.
 */
export function PosterList({ topic }: { topic: ForumTopic }) {
	const tl = useLiteralMessages();
	const shown = topic.posters.slice(0, POSTER_LIMIT);
	const names =
		topic.posters.length > 0
			? topic.posters.map((agent) => agent.name).join(", ")
			: "You";
	return (
		<span className="flex items-center gap-1" title={names}>
			<span className="sr-only">{tl("Posters: {names}", { names })}</span>
			{shown.length === 0 ? <ForumAvatar agent={null} size={24} /> : null}
			{shown.map((agent) => (
				<ForumAvatar agent={agent} key={agent.id} size={24} />
			))}
		</span>
	);
}

/** The status phrase a topic's meta line carries, in its status colour. */
export function TopicStatusNote({ topic }: { topic: ForumTopic }) {
	const note = topicStatusNote(topic);
	if (!note) {
		return null;
	}
	return (
		<span
			className={cn(
				"inline-flex shrink-0 items-center gap-1.5 text-xs leading-4",
				topic.status === "attention" && "text-destructive",
				topic.status === "working" && "text-foreground",
				topic.status === "waiting" && "text-muted-foreground"
			)}
		>
			<BoardStatusDot className="size-1.5" status={topic.status} />
			{note}
		</span>
	);
}

/** The unread dot Discourse puts after a title with new posts. */
export function UnreadDot({ className }: { className?: string }) {
	return (
		<span className={cn("inline-flex items-center", className)}>
			<span
				aria-hidden="true"
				className="inline-block size-2 rounded-full bg-primary"
			/>
			<span className="sr-only">Your turn</span>
		</span>
	);
}
