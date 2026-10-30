import {
	ArrowUpRight01Icon,
	Comment01Icon,
	FavouriteIcon,
	Settings01Icon,
	ThumbsUpIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Checkbox } from "@ryu/ui/components/checkbox.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@ryu/ui/components/popover.tsx";
import { useState } from "react";
import type { ActivityItem } from "@/src/lib/api/activity.ts";
import type {
	BotFeedEngagement,
	BotFeedPreferences,
	BotFeedSource,
} from "@/src/lib/bot-feed.ts";
import {
	FEED_SOURCE_LABELS,
	FEED_SOURCE_OPTIONS,
	relativeAge,
	sourceIcon,
	sourceLabel,
} from "./BotProfileCard-model.ts";

export function FeedPreferences({
	preferences,
	onChange,
}: {
	preferences: BotFeedPreferences;
	onChange: (source: BotFeedSource, checked: boolean) => void;
}) {
	const tl = useLiteralMessages();
	return (
		<Popover>
			<PopoverTrigger
				aria-label="Customize feed"
				render={<Button size="icon-sm" variant="ghost-muted" />}
			>
				<HugeiconsIcon className="size-4" icon={Settings01Icon} />
			</PopoverTrigger>
			<PopoverContent
				align="end"
				className="w-64"
				sideOffset={8}
				spacing="rail"
			>
				<p className="font-medium text-sm">Customize your feed</p>
				<p className="mt-0.5 text-detail text-muted-foreground">
					Choose which kinds of agent work show up here.
				</p>
				<div className="mt-3 flex flex-col gap-3">
					{FEED_SOURCE_OPTIONS.map((option) => (
						<label className="flex items-start gap-2" key={option.id}>
							<Checkbox
								aria-label={tl("Show {source}", {
									source: FEED_SOURCE_LABELS[option.id],
								})}
								checked={preferences.sources.includes(option.id)}
								onCheckedChange={(checked) =>
									onChange(option.id, checked === true)
								}
							/>
							<span className="min-w-0">
								<span className="block text-sm">
									{FEED_SOURCE_LABELS[option.id]}
								</span>
								<span className="block text-detail text-muted-foreground">
									{option.description}
								</span>
							</span>
						</label>
					))}
				</div>
			</PopoverContent>
		</Popover>
	);
}

export function ActivityPreview({
	item,
	onOpen,
}: {
	item: ActivityItem;
	onOpen: () => void;
}) {
	return (
		<button
			className="flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left transition-colors duration-150 hover:bg-muted hover:duration-0"
			onClick={onOpen}
			type="button"
		>
			<HugeiconsIcon
				className="mt-0.5 size-4 shrink-0 text-muted-foreground"
				icon={sourceIcon(item)}
			/>
			<span className="min-w-0 flex-1">
				<span className="flex items-center gap-2">
					<span className="truncate text-sm" title={item.title}>
						{item.title}
					</span>
					<span className="shrink-0 text-muted-foreground/70 text-xs tabular-nums">
						{relativeAge(item.created_at)}
					</span>
				</span>
				<span className="mt-0.5 block truncate text-detail text-muted-foreground">
					{item.body || sourceLabel(item)}
				</span>
			</span>
		</button>
	);
}

export function FeedPost({
	engagement,
	item,
	onComment,
	onLike,
	onReply,
}: {
	engagement: BotFeedEngagement;
	item: ActivityItem;
	onComment: (comment: string) => void;
	onLike: () => void;
	onReply: () => void;
}) {
	const tl = useLiteralMessages();
	const [commentOpen, setCommentOpen] = useState(false);
	const [draft, setDraft] = useState("");
	const comments = engagement.comments[item.id] ?? [];
	const liked = engagement.liked.includes(item.id);
	const submitComment = (event: React.FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		const value = draft.trim();
		if (!value) {
			return;
		}
		onComment(value);
		setDraft("");
	};
	return (
		<article className="border-border border-b px-2 py-3 last:border-b-0">
			<header className="flex items-center gap-2 text-detail text-muted-foreground">
				<HugeiconsIcon className="size-3.5 shrink-0" icon={sourceIcon(item)} />
				<span className="min-w-0 flex-1 truncate">
					{tl("Bot · {source}", { source: sourceLabel(item) })}
				</span>
				<span className="shrink-0 text-muted-foreground/70 text-xs tabular-nums">
					{tl("{age} ago", { age: relativeAge(item.created_at) })}
				</span>
			</header>
			<h4 className="mt-1 font-medium text-sm">{item.title}</h4>
			{item.body ? (
				<p className="mt-0.5 line-clamp-4 text-pretty text-detail text-muted-foreground">
					{item.body}
				</p>
			) : null}
			<div className="mt-2 flex items-center gap-1">
				<Button
					appearance={liked ? "bot-feed-action-liked" : "bot-feed-action"}
					aria-pressed={liked}
					onClick={onLike}
					size="sm"
					variant="ghost"
				>
					<HugeiconsIcon
						className="size-3.5"
						icon={liked ? ThumbsUpIcon : FavouriteIcon}
					/>
					{liked ? "Liked" : "Like"}
				</Button>
				<Button
					appearance="bot-feed-action"
					aria-expanded={commentOpen}
					onClick={() => setCommentOpen((value) => !value)}
					size="sm"
					variant="ghost"
				>
					<HugeiconsIcon className="size-3.5" icon={Comment01Icon} />
					{comments.length > 0
						? tl("Comment · {count}", { count: String(comments.length) })
						: "Comment"}
				</Button>
				<Button
					appearance="bot-feed-action"
					className="ml-auto"
					onClick={onReply}
					size="sm"
					variant="ghost"
				>
					Reply as Ryu
					<HugeiconsIcon className="size-3.5" icon={ArrowUpRight01Icon} />
				</Button>
			</div>
			{comments.length > 0 ? (
				<div className="mt-2 flex flex-col gap-1">
					{comments.map((comment, index) => (
						<p
							className="rounded-lg bg-muted px-2 py-1.5 text-detail text-muted-foreground"
							key={`${item.id}-comment-${index}`}
						>
							{comment}
						</p>
					))}
				</div>
			) : null}
			{commentOpen ? (
				<form className="mt-2 flex gap-2" onSubmit={submitComment}>
					<Input
						aria-label="Comment on this activity"
						className="min-w-0 flex-1"
						onChange={(event) => setDraft(event.target.value)}
						placeholder="Leave a note for Ryu"
						value={draft}
					/>
					<Button appearance="bot-feed-submit" size="sm" type="submit">
						Post
					</Button>
				</form>
			) : null}
		</article>
	);
}
