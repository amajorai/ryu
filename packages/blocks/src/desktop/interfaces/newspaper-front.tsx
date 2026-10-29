import { Skeleton } from "@ryu/ui/components/skeleton.tsx";
import { cn } from "@ryu/ui/lib/utils";
import { countLabel, type NewspaperStory } from "./newspaper-model.ts";
import {
	StoryByline,
	StoryDeck,
	StoryHeadline,
	StoryKicker,
} from "./newspaper-parts.tsx";

type OpenStory = (threadId: string) => void;

/** The lead: the paper's biggest head, the latest message as its deck. */
export function LeadStory({
	now,
	onOpen,
	story,
}: {
	now: number;
	onOpen: OpenStory;
	story: NewspaperStory;
}) {
	return (
		<article
			className="group/story relative"
			data-slot="lead"
			data-thread-status={story.status}
		>
			<StoryKicker story={story} />
			<StoryHeadline
				as="h2"
				className="mt-3 text-[2rem] leading-[1.1] tracking-[-0.015em] sm:text-[2.75rem]"
				onOpen={onOpen}
				story={story}
			/>
			<StoryDeck
				className="mt-4 max-w-[40rem] text-lg leading-7 sm:text-xl sm:leading-8"
				story={story}
			/>
			<StoryByline
				className="mt-4"
				detail={countLabel(story.thread.messageCount, "message")}
				now={now}
				story={story}
			/>
		</article>
	);
}

/** A front-page story with a smaller head: secondary column and package. */
export function FrontStory({
	className,
	now,
	onOpen,
	story,
}: {
	className?: string;
	now: number;
	onOpen: OpenStory;
	story: NewspaperStory;
}) {
	return (
		<article
			className={cn("group/story relative", className)}
			data-thread-status={story.status}
		>
			<StoryKicker story={story} />
			<StoryHeadline
				className="mt-2 text-xl leading-[1.2] tracking-[-0.005em]"
				onOpen={onOpen}
				story={story}
			/>
			<StoryDeck
				className="mt-2 line-clamp-3 text-[15px] leading-6"
				story={story}
			/>
			<StoryByline className="mt-3" now={now} story={story} />
		</article>
	);
}

/** The two stories set side by side under the lead, split by a column rule. */
export function LeadPackage({
	now,
	onOpen,
	stories,
}: {
	now: number;
	onOpen: OpenStory;
	stories: NewspaperStory[];
}) {
	if (stories.length === 0) {
		return null;
	}
	return (
		<div className="mt-6 grid flex-1 border-border border-t pt-5 sm:grid-cols-2">
			{stories.map((story, index) => (
				<FrontStory
					className={cn(
						index === 0
							? "sm:pr-6"
							: "max-sm:mt-5 max-sm:border-border max-sm:border-t max-sm:pt-5 sm:border-border sm:border-l sm:pl-6"
					)}
					key={story.thread.id}
					now={now}
					onOpen={onOpen}
					story={story}
				/>
			))}
		</div>
	);
}

/** The right-hand front column: stacked stories between hairline rules. */
export function SecondaryColumn({
	now,
	onOpen,
	stories,
}: {
	now: number;
	onOpen: OpenStory;
	stories: NewspaperStory[];
}) {
	return (
		<div className="flex flex-col">
			{stories.map((story, index) => (
				<FrontStory
					className={cn(index > 0 && "mt-5 border-border border-t pt-5")}
					key={story.thread.id}
					now={now}
					onOpen={onOpen}
					story={story}
				/>
			))}
		</div>
	);
}

function SkeletonStory({ lines, size }: { lines: number; size: "lg" | "md" }) {
	return (
		<div className="flex flex-col">
			<Skeleton className="h-3 w-20" radius="block" />
			<Skeleton
				className={cn("mt-3 w-11/12", size === "lg" ? "h-9" : "h-5")}
				radius="block"
			/>
			<Skeleton
				className={cn("mt-2 w-2/3", size === "lg" ? "h-9" : "h-5")}
				radius="block"
			/>
			{Array.from({ length: lines }, (_, line) => (
				<Skeleton
					className={cn("mt-2 h-3.5", line === lines - 1 ? "w-1/2" : "w-full")}
					// biome-ignore lint/suspicious/noArrayIndexKey: static placeholder lines
					key={line}
					radius="block"
				/>
			))}
			<Skeleton className="mt-4 h-3 w-28" radius="block" />
		</div>
	);
}

/** Loading: the front page's own columns, set in placeholder type. */
export function FrontSkeleton() {
	return (
		<div aria-hidden="true" className="mt-6 grid grid-cols-1 lg:grid-cols-12">
			<div className="grid grid-cols-1 md:grid-cols-3 lg:col-span-9 lg:pr-6">
				<div className="md:col-span-2 md:pr-6">
					<SkeletonStory lines={3} size="lg" />
					<div className="mt-6 grid border-border border-t pt-5 sm:grid-cols-2">
						<div className="sm:pr-6">
							<SkeletonStory lines={2} size="md" />
						</div>
						<div className="max-sm:hidden sm:border-border sm:border-l sm:pl-6">
							<SkeletonStory lines={2} size="md" />
						</div>
					</div>
				</div>
				<div className="max-md:mt-6 max-md:border-border max-md:border-t max-md:pt-6 md:border-border md:border-l md:pl-6">
					<SkeletonStory lines={2} size="md" />
					<div className="mt-5 border-border border-t pt-5">
						<SkeletonStory lines={2} size="md" />
					</div>
				</div>
			</div>
			<div className="max-lg:hidden lg:col-span-3 lg:border-border lg:border-l lg:pl-6">
				<div className="border-foreground border-t pt-2">
					<Skeleton className="h-3 w-24" radius="block" />
				</div>
				{Array.from({ length: 5 }, (_, row) => (
					<div
						className="flex items-center justify-between border-border border-b py-3"
						// biome-ignore lint/suspicious/noArrayIndexKey: static placeholder rows
						key={row}
					>
						<Skeleton className="h-3.5 w-28" radius="block" />
						<Skeleton className="h-4 w-5" radius="block" />
					</div>
				))}
			</div>
		</div>
	);
}
