import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { cn } from "@ryu/ui/lib/utils";
import type { InterfaceAgent } from "@ryuhq/protocol/interfaces";
import { useId } from "react";
import {
	joinNames,
	type NewspaperSection,
	type NewspaperStory,
	SECTION_LIMIT,
	storyAge,
	storyByline,
	storyKicker,
} from "./newspaper-model.ts";
import { BoxHead, StoryHeadline } from "./newspaper-parts.tsx";

type OpenStory = (threadId: string) => void;

const STATUS_TONE: Record<NewspaperStory["status"], string> = {
	attention: "text-destructive",
	quiet: "text-muted-foreground",
	waiting: "text-muted-foreground",
	working: "text-success",
	"your-turn": "text-primary",
};

/** One line of index type under a short head: status, byline, age. */
function IndexLine({
	now,
	showByline = true,
	story,
}: {
	now: number;
	showByline?: boolean;
	story: NewspaperStory;
}) {
	return (
		<p className="mt-1 flex flex-wrap items-baseline gap-x-1.5 text-muted-foreground text-xs leading-4">
			<span className={cn("font-medium", STATUS_TONE[story.status])}>
				{storyKicker(story)}
			</span>
			<span aria-hidden="true">·</span>
			{showByline ? (
				<>
					<span>{storyByline(story).replace(/^By /, "")}</span>
					<span aria-hidden="true">·</span>
				</>
			) : null}
			<time dateTime={story.thread.updatedAt}>
				{storyAge(story.thread.updatedAt, now)}
			</time>
		</p>
	);
}

/** A short head over its index line, the unit of briefs and section fronts. */
function IndexStory({
	now,
	onOpen,
	showByline,
	story,
}: {
	now: number;
	onOpen: OpenStory;
	showByline?: boolean;
	story: NewspaperStory;
}) {
	return (
		<li
			className="group/story relative border-border border-t py-3 first:border-t-0 first:pt-0 last:pb-0"
			data-thread-status={story.status}
		>
			<StoryHeadline
				className="text-base leading-[1.3]"
				onOpen={onOpen}
				story={story}
			/>
			<IndexLine now={now} showByline={showByline} story={story} />
		</li>
	);
}

/** "In brief": every story that did not make the front, one head each. */
export function InBrief({
	id,
	now,
	onOpen,
	stories,
}: {
	id: string;
	now: number;
	onOpen: OpenStory;
	stories: NewspaperStory[];
}) {
	const headingId = useId();
	return (
		<section aria-labelledby={headingId} className="pb-8" id={id}>
			<BoxHead id={headingId}>In brief</BoxHead>
			<ul>
				{stories.map((story) => (
					<IndexStory
						key={story.thread.id}
						now={now}
						onOpen={onOpen}
						story={story}
					/>
				))}
			</ul>
		</section>
	);
}

/** A section front: one project or team, its staff, and its stories. */
export function SectionFront({
	id,
	now,
	onNewStory,
	onOpen,
	section,
}: {
	id: string;
	now: number;
	onNewStory: (section: NewspaperSection) => void;
	onOpen: OpenStory;
	section: NewspaperSection;
}) {
	const tl = useLiteralMessages();
	const headingId = useId();
	const shown = section.stories.slice(0, SECTION_LIMIT);
	const more = section.stories.length - shown.length;
	const staff = section.members.map((agent) => agent.name);
	return (
		<section aria-labelledby={headingId} className="pb-8" id={id}>
			<BoxHead
				action={
					<Button
						aria-label={tl("New story in {name}", { name: section.group.name })}
						className="-my-1"
						onClick={() => onNewStory(section)}
						size="xs"
						type="button"
						variant="ghost-muted"
					>
						New story
					</Button>
				}
				id={headingId}
			>
				{section.group.name}
			</BoxHead>
			<p className="-mt-1 mb-3 text-muted-foreground text-xs leading-4">
				{section.group.kind === "team" ? "Team" : "Project"}
				{staff.length > 0 ? ` · ${joinNames(staff)}` : null}
			</p>
			<ul>
				{shown.map((story) => (
					<IndexStory
						key={story.thread.id}
						now={now}
						onOpen={onOpen}
						story={story}
					/>
				))}
			</ul>
			{more > 0 ? (
				<p className="mt-3 border-border border-t pt-3 text-muted-foreground text-xs">
					{tl(
						"{more, plural, one {{moreCount} more story} other {{moreCount} more stories}} in this section",
						{ more, moreCount: String(more) }
					)}
				</p>
			) : null}
		</section>
	);
}

/** "Staff": the agents on the paper and their beats. */
export function StaffBox({
	agents,
	id,
	onAssign,
}: {
	agents: InterfaceAgent[];
	id: string;
	onAssign: (agentId: string) => void;
}) {
	const tl = useLiteralMessages();
	const headingId = useId();
	if (agents.length === 0) {
		return null;
	}
	return (
		<section aria-labelledby={headingId} className="pb-8" id={id}>
			<BoxHead id={headingId}>Staff</BoxHead>
			<ul>
				{agents.map((agent) => (
					<li
						className="border-border border-t first:border-t-0 [&:first-child>button]:pt-0"
						key={agent.id}
					>
						<button
							aria-label={tl("New story with {name}", { name: agent.name })}
							className="group/staff -mx-2 flex w-[calc(100%+1rem)] cursor-pointer rounded-sm px-2 py-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
							onClick={() => onAssign(agent.id)}
							type="button"
						>
							<span className="flex min-w-0 flex-1 flex-col">
								<span className="flex items-baseline justify-between gap-2">
									<span className="font-semibold font-serif text-base text-foreground leading-5 decoration-1 underline-offset-[0.2em] group-hover/staff:underline">
										{agent.name}
									</span>
									{agent.status === "working" ? (
										<span className="shrink-0 font-medium text-success text-xs">
											On assignment
										</span>
									) : null}
								</span>
								<span className="mt-1 truncate text-muted-foreground text-xs leading-4">
									{agent.description}
								</span>
							</span>
						</button>
					</li>
				))}
			</ul>
		</section>
	);
}
