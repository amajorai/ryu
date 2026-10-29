import { cn } from "@ryu/ui/lib/utils";
import { useEffect, useId, useMemo, useRef } from "react";
import { isInterfaceCovered } from "./interface-keys.ts";
import type { InterfaceRendererProps } from "./interface-renderer.ts";
import { NewspaperArticle } from "./newspaper-article.tsx";
import { NewspaperComposer } from "./newspaper-composer.tsx";
import {
	FrontSkeleton,
	LeadPackage,
	LeadStory,
	SecondaryColumn,
} from "./newspaper-front.tsx";
import {
	NewspaperMasthead,
	type NewspaperNavItem,
} from "./newspaper-masthead.tsx";
import {
	buildEdition,
	glanceCounts,
	type NewspaperSection,
	newspaperAnchor,
	upcomingEvents,
} from "./newspaper-model.ts";
import { useNewspaperClock } from "./newspaper-parts.tsx";
import { InBrief, SectionFront, StaffBox } from "./newspaper-sections.tsx";
import { AtAGlance, UpcomingRuns } from "./newspaper-sidebar.tsx";
import { useReducedMotion } from "./reduced-motion.ts";

function isTypingTarget(target: EventTarget | null): boolean {
	return (
		target instanceof HTMLElement &&
		(target.isContentEditable ||
			target.closest("input, textarea, select, [contenteditable='true']") !==
				null)
	);
}

/**
 * Newspaper: the workspace as a broadsheet front page. The most urgent
 * conversation is the lead, the next ones run under smaller heads, the rest
 * are briefs, and projects and teams get section fronts. A headline opens the
 * article page, whose body is the host's own conversation surface.
 */
export function NewspaperInterface({
	activeThreadId,
	loading,
	port,
	snapshot,
	threadView,
}: InterfaceRendererProps<Record<string, never>>) {
	const edition = useMemo(() => buildEdition(snapshot), [snapshot]);
	const counts = useMemo(() => glanceCounts(edition.stories), [edition]);
	const now = useNewspaperClock();
	const reduceMotion = useReducedMotion();
	const baseId = useId();
	const anchor = (key: string) => newspaperAnchor(`${baseId}-${key}`);

	const rootRef = useRef<HTMLDivElement>(null);
	const headingRef = useRef<HTMLHeadingElement>(null);
	const threadRef = useRef<HTMLDivElement>(null);
	const composerRef = useRef<HTMLTextAreaElement>(null);
	const openedFromRef = useRef<string | null>(null);

	const isOpen = threadView !== null && threadView !== undefined;
	const openStory = edition.stories.find(
		(story) => story.thread.id === activeThreadId
	);

	// Move focus with the page: to the article headline when a story opens,
	// back to the headline that opened it when the reader returns.
	useEffect(() => {
		if (isOpen) {
			headingRef.current?.focus({ preventScroll: true });
			return;
		}
		const openedFrom = openedFromRef.current;
		if (!openedFrom) {
			return;
		}
		openedFromRef.current = null;
		const headlines =
			rootRef.current?.querySelectorAll<HTMLElement>(
				"button[data-thread-id]"
			) ?? [];
		for (const headline of headlines) {
			if (headline.dataset.threadId === openedFrom) {
				headline.focus();
				return;
			}
		}
	}, [isOpen]);

	const closeRef = useRef(port.closeThread);
	closeRef.current = port.closeThread;
	useEffect(() => {
		if (!isOpen) {
			return;
		}
		const onKeyDown = (event: KeyboardEvent) => {
			if (isInterfaceCovered(rootRef.current)) {
				return;
			}
			if (
				event.key !== "Escape" ||
				event.defaultPrevented ||
				event.isComposing
			) {
				return;
			}
			const target = event.target;
			// Inside the host's conversation, its own keys win.
			if (
				isTypingTarget(target) ||
				(target instanceof Node && threadRef.current?.contains(target))
			) {
				return;
			}
			event.preventDefault();
			closeRef.current();
		};
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, [isOpen]);

	const open = (threadId: string) => {
		openedFromRef.current = threadId;
		port.openThread(threadId);
	};
	const jump = (target: string) => {
		const element = rootRef.current?.ownerDocument.getElementById(target);
		element?.scrollIntoView({
			behavior: reduceMotion ? "auto" : "smooth",
			block: "start",
		});
	};
	const focusComposer = () => {
		const field = composerRef.current;
		if (!field) {
			return;
		}
		field.scrollIntoView({
			behavior: reduceMotion ? "auto" : "smooth",
			block: "center",
		});
		field.focus({ preventScroll: true });
	};
	const fileStory = ({
		agentId,
		prompt,
	}: {
		agentId?: string;
		prompt: string;
	}) => {
		port.startThread({ agentId, prompt });
	};
	const newSectionStory = (section: NewspaperSection) => {
		port.startThread(
			section.group.kind === "project"
				? { projectId: section.group.id }
				: { teamId: section.group.id }
		);
	};

	if (isOpen) {
		return (
			<div
				className="size-full bg-background text-foreground"
				data-state="open"
				data-testid="interface-newspaper"
				ref={rootRef}
			>
				<NewspaperArticle
					headingRef={headingRef}
					now={now}
					onBack={() => port.closeThread()}
					onOpen={open}
					others={edition.stories.filter(
						(story) => story.thread.id !== activeThreadId
					)}
					story={openStory}
					threadRef={threadRef}
					threadView={threadView}
				/>
			</div>
		);
	}

	const events = snapshot.events;
	const upcoming = upcomingEvents(events, now);
	const agentsWorking = snapshot.agents.filter(
		(agent) => agent.status === "working"
	).length;
	const empty = !loading && edition.stories.length === 0;
	const hasBriefs = edition.briefs.length > 0;
	const hasSections = edition.sections.length > 0;

	const nav: NewspaperNavItem[] = [];
	if (!(loading || empty)) {
		nav.push({ anchor: anchor("front"), label: "Front page" });
		if (edition.briefs.length > 0) {
			nav.push({ anchor: anchor("briefs"), label: "In brief" });
		}
		for (const section of edition.sections) {
			nav.push({
				anchor: anchor(`section-${section.group.id}`),
				label: section.group.name,
			});
		}
		if (events) {
			nav.push({ anchor: anchor("upcoming"), label: "Upcoming" });
		}
		if (snapshot.agents.length > 0) {
			nav.push({ anchor: anchor("staff"), label: "Staff" });
		}
	}

	const composer = (
		<NewspaperComposer
			agents={snapshot.agents}
			id={anchor("submit")}
			inputRef={composerRef}
			onSubmit={fileStory}
		/>
	);

	let body = <FrontSkeleton />;
	if (empty) {
		body = (
			<div className="mx-auto grid w-full max-w-4xl gap-x-12 gap-y-10 pt-16 pb-8 md:grid-cols-[1fr_20rem]">
				<div>
					<p className="font-sans font-semibold text-[11px] text-muted-foreground uppercase leading-4 tracking-[0.08em]">
						First edition
					</p>
					<h2 className="mt-3 text-balance text-4xl text-foreground leading-[1.1] tracking-[-0.015em]">
						<span className="font-semibold font-serif">
							No stories have been filed yet
						</span>
					</h2>
					<p className="mt-4 max-w-md text-pretty font-serif text-foreground/80 text-lg leading-7">
						{snapshot.agents.length > 0
							? "Every conversation with an agent runs here as a story, the most urgent one on top. Submit the first assignment to start the paper."
							: "Every conversation with an agent runs here as a story. Add an agent to the workspace to file the first one."}
					</p>
				</div>
				{snapshot.agents.length > 0 ? composer : null}
			</div>
		);
	} else if (!loading && edition.lead) {
		body = (
			<div className="mt-6 grid grid-cols-1 lg:grid-cols-12">
				<div className="lg:col-span-9 lg:pr-6">
					<section
						aria-label="Front page"
						className="grid scroll-mt-4 grid-cols-1 md:grid-cols-3"
						id={anchor("front")}
					>
						<div className="flex flex-col md:col-span-2 md:pr-6">
							<LeadStory now={now} onOpen={open} story={edition.lead} />
							<LeadPackage now={now} onOpen={open} stories={edition.package} />
						</div>
						{edition.secondary.length > 0 ? (
							<div className="max-md:mt-6 max-md:border-border max-md:border-t max-md:pt-6 md:border-border md:border-l md:pl-6">
								<SecondaryColumn
									now={now}
									onOpen={open}
									stories={edition.secondary}
								/>
							</div>
						) : null}
					</section>
					<div className="mt-10 grid grid-cols-1 md:grid-cols-3 [&_section]:scroll-mt-4">
						<div className="grid grid-cols-1 sm:grid-cols-2 md:col-span-2 md:pr-6">
							{hasBriefs ? (
								<div className={cn(hasSections ? "sm:pr-6" : "sm:col-span-2")}>
									<InBrief
										id={anchor("briefs")}
										now={now}
										onOpen={open}
										stories={edition.briefs}
									/>
								</div>
							) : null}
							{hasSections ? (
								<div
									className={cn(
										hasBriefs
											? "sm:border-border sm:border-l sm:pl-6"
											: "sm:col-span-2"
									)}
								>
									{edition.sections.map((section) => (
										<SectionFront
											id={anchor(`section-${section.group.id}`)}
											key={section.group.id}
											now={now}
											onNewStory={newSectionStory}
											onOpen={open}
											section={section}
										/>
									))}
								</div>
							) : null}
						</div>
						<div className="md:border-border md:border-l md:pl-6">
							<StaffBox
								agents={snapshot.agents}
								id={anchor("staff")}
								onAssign={(agentId) => port.startThread({ agentId })}
							/>
						</div>
					</div>
				</div>
				<aside
					aria-label="Sidebar"
					className="grid content-start gap-x-12 gap-y-10 max-lg:mt-2 max-lg:border-border max-lg:border-t max-lg:pt-8 sm:max-lg:grid-cols-2 lg:col-span-3 lg:border-border lg:border-l lg:pl-6 [&>section]:scroll-mt-4"
				>
					<AtAGlance
						agentCount={snapshot.agents.length}
						agentsWorking={agentsWorking}
						counts={counts}
						id={anchor("glance")}
					/>
					{events ? (
						<UpcomingRuns
							agents={snapshot.agents}
							events={upcoming}
							id={anchor("upcoming")}
							now={now}
						/>
					) : null}
					{composer}
				</aside>
			</div>
		);
	}

	return (
		<div
			aria-busy={loading || undefined}
			className="size-full overflow-y-auto bg-background text-foreground"
			data-state={empty ? "empty" : "front"}
			data-testid="interface-newspaper"
			ref={rootRef}
		>
			<div className="mx-auto w-full max-w-[90rem] px-4 pb-16 sm:px-6 lg:px-8">
				<NewspaperMasthead
					agentCount={snapshot.agents.length}
					liveCount={agentsWorking}
					loading={loading}
					nav={nav}
					now={now}
					onJump={jump}
					onSubmit={focusComposer}
					storyCount={edition.stories.length}
				/>
				{body}
			</div>
		</div>
	);
}
