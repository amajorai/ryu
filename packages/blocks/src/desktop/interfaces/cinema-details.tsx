import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { cn } from "@ryu/ui/lib/utils";
import { MessageSquarePlus, Play, X } from "lucide-react";
import { motion } from "motion/react";
import {
	type KeyboardEvent,
	type ReactNode,
	useEffect,
	useId,
	useRef,
} from "react";
import { CinemaArt } from "./cinema-art.tsx";
import {
	type CinemaTitle,
	cinemaAge,
	cinemaLastSpeaker,
	cinemaMessages,
	cinemaNames,
	cinemaStatusText,
} from "./cinema-model.ts";
import { CinemaBoxart } from "./cinema-poster.tsx";
import { compactAge } from "./interface-renderer.ts";

const STATUS_TONE: Record<CinemaTitle["status"], string> = {
	attention: "text-destructive",
	quiet: "text-muted-foreground",
	waiting: "text-muted-foreground",
	working: "text-success",
	"your-turn": "text-primary",
};

const FOCUSABLE =
	"button:not([disabled]), [href], input, [tabindex]:not([tabindex='-1'])";

/** Keeps Tab inside the dialog. */
function trapTab(event: KeyboardEvent<HTMLElement>) {
	if (event.key !== "Tab") {
		return;
	}
	const items = [
		...event.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE),
	];
	const first = items[0];
	const last = items.at(-1);
	if (!(first && last)) {
		return;
	}
	if (event.shiftKey && document.activeElement === first) {
		event.preventDefault();
		last.focus();
	} else if (!event.shiftKey && document.activeElement === last) {
		event.preventDefault();
		first.focus();
	}
}

function Fact({ label, children }: { children: ReactNode; label: string }) {
	return (
		<div className="text-sm leading-5">
			<dt className="inline text-muted-foreground">{label}: </dt>
			<dd className="inline text-foreground">{children}</dd>
		</div>
	);
}

function groupLabel(title: CinemaTitle): string {
	return title.group?.kind === "project" ? "Project" : "Team";
}

export interface CinemaDetailsProps {
	compact: boolean;
	now: number;
	onClose: () => void;
	onNew: (agentId: string) => void;
	onOpen: (threadId: string) => void;
	onSelect: (threadId: string) => void;
	reduceMotion: boolean;
	related: readonly CinemaTitle[];
	title: CinemaTitle;
}

/**
 * "More info": the title's details as the reference's modal lays them out.
 * Art with the title and Open, then the state and latest message beside who
 * and where, "More like this", and an About block. It stays inside the
 * interface frame, traps focus, and closes on Escape or a click outside.
 */
export function CinemaDetails({
	compact,
	now,
	onClose,
	onNew,
	onOpen,
	onSelect,
	reduceMotion,
	related,
	title,
}: CinemaDetailsProps) {
	const tl = useLiteralMessages();
	const headingId = useId();
	const closeRef = useRef<HTMLButtonElement>(null);
	const scrollRef = useRef<HTMLDivElement>(null);
	const thread = title.thread;
	const agent = title.agents[0];
	const names = cinemaNames(title.agents);
	const age = cinemaAge(compactAge(thread.updatedAt, now));

	// Focus lands on Close, and each title (including one picked from "More
	// like this") starts at the top.
	useEffect(() => {
		if (!thread.id) {
			return;
		}
		closeRef.current?.focus({ preventScroll: true });
		scrollRef.current?.scrollTo({ top: 0 });
	}, [thread.id]);

	return (
		<motion.div
			animate={{ opacity: 1 }}
			className="absolute inset-0 z-50 overflow-y-auto overscroll-contain bg-background/80"
			data-testid="cinema-details"
			exit={{ opacity: 0 }}
			initial={{ opacity: 0 }}
			onClick={(event) => {
				if (event.target === event.currentTarget) {
					onClose();
				}
			}}
			ref={scrollRef}
			transition={{ duration: 0.2 }}
		>
			<motion.div
				animate={{ opacity: 1, scale: 1, y: 0 }}
				aria-labelledby={headingId}
				aria-modal="true"
				className={cn(
					"relative mx-auto w-full max-w-[850px] overflow-hidden bg-card text-card-foreground shadow-2xl ring-1 ring-border",
					compact ? "min-h-full" : "my-8 rounded-md"
				)}
				initial={
					reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.96, y: 16 }
				}
				onKeyDown={(event) => {
					if (event.key === "Escape") {
						event.preventDefault();
						event.stopPropagation();
						onClose();
						return;
					}
					trapTab(event);
				}}
				role="dialog"
				transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
			>
				<div className="relative aspect-video w-full overflow-hidden">
					<CinemaArt
						className="absolute inset-0"
						frame="hero"
						spec={title.art}
						text={thread.title}
					/>
					<div
						aria-hidden="true"
						className="absolute inset-x-0 bottom-0 h-3/5 bg-linear-to-t from-card via-card/60 to-transparent"
					/>
					<div
						aria-hidden="true"
						className="absolute inset-y-0 left-0 w-3/5 bg-linear-to-r from-card/60 to-transparent"
					/>
					<div
						className={cn(
							"absolute bottom-0 left-0 flex flex-col items-start gap-5",
							compact ? "w-full px-4 pb-4" : "w-3/5 px-12 pb-10"
						)}
					>
						<h2 className="text-foreground" id={headingId}>
							<span
								className={cn(
									"line-clamp-3 text-balance font-bold tracking-tight",
									compact ? "text-2xl leading-8" : "text-4xl leading-[44px]"
								)}
							>
								{thread.title}
							</span>
						</h2>
						<div className="flex items-center gap-2">
							<Button
								className="h-10 gap-2 rounded-sm bg-foreground px-6 font-semibold text-background text-base hover:bg-foreground/80"
								onClick={() => onOpen(thread.id)}
								type="button"
							>
								<Play aria-hidden="true" className="size-5 fill-current" />
								Open
							</Button>
							{agent ? (
								<button
									aria-label={tl("New thread with {name}", {
										name: agent.name,
									})}
									className="flex size-10 items-center justify-center rounded-full border-2 border-foreground/40 bg-card/40 text-foreground outline-none transition-colors hover:border-foreground focus-visible:ring-2 focus-visible:ring-ring"
									onClick={() => onNew(agent.id)}
									title={tl("New thread with {name}", { name: agent.name })}
									type="button"
								>
									<MessageSquarePlus aria-hidden="true" className="size-4" />
								</button>
							) : null}
						</div>
					</div>
					<button
						aria-label="Close"
						className="absolute top-4 right-4 flex size-9 items-center justify-center rounded-full bg-card text-foreground outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
						onClick={onClose}
						ref={closeRef}
						type="button"
					>
						<X aria-hidden="true" className="size-5" />
					</button>
				</div>

				<div className={cn(compact ? "px-4 pb-8" : "px-12 pb-12")}>
					<div
						className={cn(
							"grid gap-x-8 gap-y-4",
							compact
								? "grid-cols-1"
								: "grid-cols-[minmax(0,2fr)_minmax(0,1fr)]"
						)}
					>
						<div className="flex min-w-0 flex-col gap-4">
							<p className="flex flex-wrap items-baseline gap-x-3 text-base leading-6">
								<span
									className={cn("font-semibold", STATUS_TONE[title.status])}
								>
									{cinemaStatusText(title)}
								</span>
								<span className="text-foreground/80">
									{cinemaMessages(thread.messageCount)}
								</span>
								<span className="text-foreground/80">{age}</span>
							</p>
							{thread.lastMessage ? (
								<blockquote className="text-base text-foreground leading-7">
									<span className="mr-2 font-semibold">
										{cinemaLastSpeaker(title)}
									</span>
									{thread.lastMessage}
								</blockquote>
							) : (
								<p className="text-base text-muted-foreground leading-7">
									No messages yet.
								</p>
							)}
						</div>
						<dl className="flex min-w-0 flex-col gap-3">
							<Fact label="Agents">{names || "None"}</Fact>
							{title.group ? (
								<Fact label={groupLabel(title)}>{title.group.name}</Fact>
							) : null}
							{thread.pinned ? <Fact label="Pinned">Yes</Fact> : null}
						</dl>
					</div>

					{related.length > 0 ? (
						<section aria-label="More like this" className="mt-12">
							<h3 className="mb-4 text-foreground text-xl leading-7 tracking-tight">
								<span className="font-semibold">More like this</span>
							</h3>
							<ul
								className={cn(
									"grid gap-4",
									compact ? "grid-cols-2" : "grid-cols-3"
								)}
							>
								{related.map((item) => (
									<li
										className="flex flex-col overflow-hidden rounded-md bg-muted"
										key={item.thread.id}
									>
										<button
											aria-label={tl("More info: {title}", {
												title: item.thread.title,
											})}
											className="block cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
											onClick={() => onSelect(item.thread.id)}
											type="button"
										>
											<CinemaBoxart title={item} />
										</button>
										<div className="flex flex-1 flex-col gap-2 p-4">
											<div className="flex items-center justify-between gap-2">
												<span className="flex min-w-0 flex-col">
													<span
														className={cn(
															"truncate font-semibold text-sm leading-5",
															STATUS_TONE[item.status]
														)}
													>
														{cinemaStatusText(item)}
													</span>
													<span className="truncate text-foreground/70 text-sm leading-5">
														{cinemaAge(compactAge(item.thread.updatedAt, now))}
													</span>
												</span>
												<button
													aria-label={tl("Open {title}", {
														title: item.thread.title,
													})}
													className="flex size-9 shrink-0 items-center justify-center rounded-full border-2 border-foreground/40 text-foreground outline-none transition-colors hover:border-foreground focus-visible:ring-2 focus-visible:ring-ring"
													onClick={() => onOpen(item.thread.id)}
													title="Open"
													type="button"
												>
													<Play
														aria-hidden="true"
														className="ml-0.5 size-4 fill-current"
													/>
												</button>
											</div>
											{item.thread.lastMessage ? (
												<p className="line-clamp-4 text-foreground/75 text-sm leading-5">
													{item.thread.lastMessage}
												</p>
											) : null}
										</div>
									</li>
								))}
							</ul>
						</section>
					) : null}

					<section
						aria-label={tl("About {title}", { title: thread.title })}
						className="mt-12"
					>
						<h3 className="mb-4 text-foreground text-xl leading-7 tracking-tight">
							About <span className="font-bold">{thread.title}</span>
						</h3>
						<dl className="flex flex-col gap-3">
							<Fact label="Agents">
								{title.agents.length > 0
									? title.agents
											.map((item) =>
												item.description
													? `${item.name} (${item.description})`
													: item.name
											)
											.join(", ")
									: "None"}
							</Fact>
							{title.group ? (
								<Fact label={groupLabel(title)}>{title.group.name}</Fact>
							) : null}
							<Fact label="Last message">{cinemaLastSpeaker(title)}</Fact>
							<Fact label="Size">{cinemaMessages(thread.messageCount)}</Fact>
							<Fact label="Updated">{age}</Fact>
						</dl>
					</section>
				</div>
			</motion.div>
		</motion.div>
	);
}
