"use client";

// The home-page hero's live demo of the desktop's Projects › Bots/Groups ›
// Sessions layout. It is built from the same pieces the desktop renders: the
// shared `DesktopShell` window chrome and `@ryu/ui` sidebar primitives, the
// messaging-style rows, the thread hierarchy bar, and the REAL `SessionCardTool`
// the desktop draws for a coordinator's `threads.*` calls. Data is static and
// nothing touches the network; a short scripted timeline moves the sessions from
// starting to done, and "Open session" switches the pane to that session.

import {
	ArrowDown01Icon,
	ArrowUp02Icon,
	BubbleChatIcon,
	Folder01Icon,
	FolderOpenIcon,
	PencilEdit01Icon,
	Search01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { EntityAvatar } from "@ryu/ui/components/entity-avatar.tsx";
import {
	SidebarGroup,
	SidebarGroupContent,
	SidebarMenu,
	SidebarMenuItem,
} from "@ryu/ui/components/sidebar";
import { cn } from "@ryu/ui/lib/utils";
import { type ReactNode, useEffect, useState } from "react";
import { SessionCardTool } from "../desktop/agent-elements/tools/session-card-tool.tsx";
import {
	OPEN_CONVERSATION_EVENT,
	type OpenConversationEvent,
} from "../desktop/agent-elements/tools/session-card-tool-logic.ts";
import { DesktopShell } from "../desktop/shell.tsx";

/** One scripted session the coordinator delegates. */
interface DemoSession {
	agent: string;
	id: string;
	reply: string;
	title: string;
	transcript: { role: "user" | "assistant"; text: string }[];
}

const SESSIONS: DemoSession[] = [
	{
		agent: "scout",
		id: "demo-session-copy",
		reply: "Landing copy is tightened and the hero CTA now matches pricing.",
		title: "Audit landing copy",
		transcript: [
			{
				role: "user",
				text: "Audit the launch page copy against the pricing page and fix mismatches.",
			},
			{
				role: "assistant",
				text: "Found 3 mismatches. Updated the hero CTA, the plan names, and the FAQ answer about seats.",
			},
		],
	},
	{
		agent: "designer",
		id: "demo-session-og",
		reply: "Social cards exported in light and dark.",
		title: "Make social cards",
		transcript: [
			{ role: "user", text: "Make the Open Graph images for the launch." },
			{
				role: "assistant",
				text: "Exported 1200×630 cards in light and dark, using the new wordmark.",
			},
		],
	},
	{
		agent: "qa",
		id: "demo-session-qa",
		reply: "All 42 checks pass on the staging build.",
		title: "Run launch checks",
		transcript: [
			{ role: "user", text: "Run the launch checklist on staging." },
			{
				role: "assistant",
				text: "All 42 checks pass. Lighthouse 98, no broken links, forms submit.",
			},
		],
	},
];

type Phase = 0 | 1 | 2 | 3 | 4;

/** Which status each session shows at each phase of the loop. */
function sessionState(
	index: number,
	phase: Phase
): "starting" | "running" | "done" {
	if (phase === 0) {
		return "starting";
	}
	if (phase >= 2 + index) {
		return "done";
	}
	return "running";
}

/** A tool part shaped exactly like the one Core streams for `threads.*`. */
function sessionPart(
	session: DemoSession,
	state: "starting" | "running" | "done"
) {
	if (state === "starting") {
		return {
			input: { agent_id: session.agent, title: session.title },
			output: { ok: true, thread_id: session.id, title: session.title },
			state: "output-available",
			toolName: "threads.create_thread",
			type: "dynamic-tool",
		};
	}
	return {
		input: {
			message: session.transcript[0]?.text,
			thread_id: session.id,
			wait: state === "done",
		},
		// Core echoes the session's title and bot on every threads.* result.
		output:
			state === "done"
				? {
						agent_id: session.agent,
						ok: true,
						reply: session.reply,
						thread_id: session.id,
						title: session.title,
					}
				: {
						agent_id: session.agent,
						dispatched: true,
						ok: true,
						status: "running",
						thread_id: session.id,
						title: session.title,
					},
		state: "output-available",
		toolName: "threads.send_message_to_thread",
		type: "dynamic-tool",
	};
}

function usePrefersReducedMotion(): boolean {
	const [reduced, setReduced] = useState(false);
	useEffect(() => {
		if (globalThis.window === undefined || !window.matchMedia) {
			return;
		}
		const query = window.matchMedia("(prefers-reduced-motion: reduce)");
		setReduced(query.matches);
		const onChange = () => setReduced(query.matches);
		query.addEventListener("change", onChange);
		return () => query.removeEventListener("change", onChange);
	}, []);
	return reduced;
}

/** The messaging-style row every sidebar entity uses on the desktop. */
function MessagingRow({
	active,
	avatar,
	name,
	preview,
	running,
	stamp,
	badge,
}: {
	active?: boolean;
	avatar: ReactNode;
	badge?: string;
	name: string;
	preview: string;
	running?: boolean;
	stamp: string;
}) {
	return (
		<SidebarMenuItem>
			<div
				className={cn(
					"flex min-h-14 w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors",
					active ? "bg-muted" : "hover:bg-muted"
				)}
			>
				{avatar}
				<span className="flex min-w-0 flex-1 flex-col justify-center gap-0.5">
					<span className="flex min-w-0 items-center gap-2">
						<span className="min-w-0 flex-1 truncate text-sm">{name}</span>
						{running ? (
							<span
								aria-label="A session is running"
								className="size-3 shrink-0 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-muted-foreground/80"
								role="img"
							/>
						) : (
							<span className="type-compact shrink-0 text-muted-foreground tabular-nums">
								{stamp}
							</span>
						)}
					</span>
					<span className="flex min-w-0 items-center gap-1.5">
						<span className="min-w-0 flex-1 truncate text-muted-foreground text-xs">
							{preview}
						</span>
						{badge ? (
							<span className="type-compact shrink-0 rounded-full bg-muted px-1.5 py-px text-muted-foreground">
								{badge}
							</span>
						) : null}
					</span>
				</span>
			</div>
		</SidebarMenuItem>
	);
}

function GlyphAvatar({ emoji, tone }: { emoji: string; tone: string }) {
	return (
		<span
			aria-hidden="true"
			className={cn(
				"flex size-9 shrink-0 items-center justify-center rounded-full text-base",
				tone
			)}
		>
			{emoji}
		</span>
	);
}

function GroupAvatar({ names }: { names: string[] }) {
	return (
		<span aria-hidden="true" className="relative size-9 shrink-0">
			{names.slice(0, 2).map((name, index) => (
				<span
					className={cn(
						"absolute size-6 rounded-full ring-2 ring-sidebar",
						index === 0 ? "top-0 left-0" : "right-0 bottom-0"
					)}
					key={name}
				>
					<EntityAvatar className="size-6" name={name} />
				</span>
			))}
		</span>
	);
}

/** A sub-section header inside "Projects & chats", like the desktop's SubSection. */
function SubSectionLabel({
	icon,
	label,
	count,
}: {
	count: number;
	icon: typeof Folder01Icon;
	label: string;
}) {
	return (
		<div className="flex items-center gap-1.5 px-2 pt-2 pb-1 text-muted-foreground text-xs">
			<HugeiconsIcon className="size-3.5" icon={icon} />
			<span>{label}</span>
			<span className="text-muted-foreground/60 tabular-nums">{count}</span>
		</div>
	);
}

function SectionHeader({ label }: { label: string }) {
	return (
		<div className="flex items-center gap-2 rounded-md px-2 py-1.5 text-muted-foreground text-xs">
			<span>{label}</span>
			<HugeiconsIcon className="-ml-1 size-3" icon={ArrowDown01Icon} />
		</div>
	);
}

function DemoSidebar({ phase, view }: { phase: Phase; view: string }) {
	const projectRunning = phase > 0 && phase < 4;
	return (
		<div className="flex flex-col" data-testid="hierarchy-demo-sidebar">
			<SidebarGroup spacing="compact">
				<SectionHeader label="Bots" />
				<SidebarGroupContent>
					<SidebarMenu>
						<MessagingRow
							avatar={<EntityAvatar className="size-9 shrink-0" name="Ryu" />}
							name="Ryu"
							preview="Your week is clear after 3pm"
							stamp="9:41"
						/>
						<MessagingRow
							avatar={<EntityAvatar className="size-9 shrink-0" name="Scout" />}
							name="Scout"
							preview="Pricing page reviewed"
							stamp="9:12"
						/>
					</SidebarMenu>
				</SidebarGroupContent>
			</SidebarGroup>
			<SidebarGroup spacing="compact">
				<SectionHeader label="Projects & chats" />
				<SidebarGroupContent>
					<SubSectionLabel count={2} icon={Folder01Icon} label="Projects" />
					<SidebarMenu>
						<MessagingRow
							active={view === "project"}
							avatar={<GlyphAvatar emoji="🚀" tone="bg-primary/10" />}
							name="Product launch"
							preview={
								phase >= 4
									? "Coordinator: all three sessions are done"
									: "Coordinator: delegating to 3 sessions"
							}
							running={projectRunning}
							stamp="Now"
						/>
						<MessagingRow
							avatar={<GlyphAvatar emoji="🔬" tone="bg-success/10" />}
							name="Q4 research"
							preview="Analyst: competitor table updated"
							stamp="Tue"
						/>
					</SidebarMenu>
					<SubSectionLabel count={2} icon={BubbleChatIcon} label="Chats" />
					<SidebarMenu>
						<MessagingRow
							avatar={<GroupAvatar names={["Reviewer", "Critic"]} />}
							badge="Debate"
							name="Reviewers"
							preview="Critic: tighten the second paragraph"
							stamp="Mon"
						/>
						<MessagingRow
							avatar={<EntityAvatar className="size-9 shrink-0" name="Ana" />}
							name="Ana"
							preview="You: shipping Friday 🎉"
							stamp="Sun"
						/>
					</SidebarMenu>
					<SubSectionLabel
						count={1}
						icon={FolderOpenIcon}
						label="Launch week"
					/>
					<SidebarMenu>
						<MessagingRow
							avatar={<GlyphAvatar emoji="📰" tone="bg-warning/10" />}
							name="Press kit"
							preview="Writer: embargo notes drafted"
							stamp="Sat"
						/>
					</SidebarMenu>
				</SidebarGroupContent>
			</SidebarGroup>
		</div>
	);
}

function Crumbs({ items, onBack }: { items: string[]; onBack: () => void }) {
	return (
		<nav aria-label="Thread location" className="min-w-0">
			<ol className="flex min-w-0 items-center gap-1.5 text-muted-foreground text-sm">
				{items.map((item, index) => {
					const last = index === items.length - 1;
					return (
						<li className="flex min-w-0 items-center gap-1.5" key={item}>
							{index > 0 ? <span aria-hidden="true">›</span> : null}
							{last ? (
								<span className="truncate text-foreground">{item}</span>
							) : (
								<button
									className="truncate transition-colors hover:text-foreground"
									onClick={onBack}
									type="button"
								>
									{item}
								</button>
							)}
						</li>
					);
				})}
			</ol>
		</nav>
	);
}

function UserBubble({ children }: { children: ReactNode }) {
	return (
		<div className="flex justify-end">
			<p className="max-w-[80%] rounded-2xl bg-muted px-4 py-2 text-sm">
				{children}
			</p>
		</div>
	);
}

function AssistantText({ children }: { children: ReactNode }) {
	return <p className="text-sm leading-relaxed">{children}</p>;
}

function Composer({ placeholder }: { placeholder: string }) {
	return (
		<div className="mx-4 mb-4 flex items-center gap-2 rounded-3xl border border-border bg-card px-4 py-2.5 shadow-sm">
			<span className="min-w-0 flex-1 truncate text-muted-foreground text-sm">
				{placeholder}
			</span>
			<span className="flex size-7 items-center justify-center rounded-full bg-foreground text-background">
				<HugeiconsIcon className="size-4" icon={ArrowUp02Icon} />
			</span>
		</div>
	);
}

// Window frame, title bar and pane height of the demo window.
const DEMO_FRAME_CLASS =
	"overflow-hidden rounded-2xl border border-border bg-background shadow-2xl";
const DEMO_PANE_CLASS = "h-[660px] text-left";

function DemoTitleBar({ title }: { title: string }) {
	return (
		<div className="flex items-center gap-1.5 border-border/60 border-b bg-muted/40 px-3 py-2">
			<span className="size-2.5 rounded-full bg-foreground/15" />
			<span className="size-2.5 rounded-full bg-foreground/15" />
			<span className="size-2.5 rounded-full bg-foreground/15" />
			<span className="ml-3 truncate font-medium text-muted-foreground text-xs">
				{title}
			</span>
		</div>
	);
}

/**
 * A pixel-faithful, interactive demo of the desktop's Projects › Bots/Groups ›
 * Sessions UI for the landing hero.
 */
export function HierarchyDesktopDemo({ className }: { className?: string }) {
	const reducedMotion = usePrefersReducedMotion();
	const [phase, setPhase] = useState<Phase>(0);
	const [openSession, setOpenSession] = useState<DemoSession | null>(null);
	const [defaultsOpen, setDefaultsOpen] = useState(false);

	useEffect(() => {
		if (reducedMotion) {
			setPhase(4);
			return;
		}
		const timer = window.setInterval(() => {
			// SAFETY: phase starts at 0, reduced motion writes 4, and this sole timer
			// updater wraps 4 to 0; the remaining native Phase values 0–3 increment to 1–4.
			setPhase((current) => (current >= 4 ? 0 : ((current + 1) as Phase)));
		}, 1800);
		return () => window.clearInterval(timer);
	}, [reducedMotion]);

	// The real session card raises the same open request the desktop listens for.
	useEffect(() => {
		const onOpen = (event: OpenConversationEvent) => {
			const id = event.detail?.conversationId;
			const session = SESSIONS.find((item) => item.id === id);
			if (session) {
				setOpenSession(session);
				setDefaultsOpen(false);
			}
		};
		window.addEventListener(OPEN_CONVERSATION_EVENT, onOpen);
		return () => window.removeEventListener(OPEN_CONVERSATION_EVENT, onOpen);
	}, []);

	const done = SESSIONS.filter(
		(_, index) => sessionState(index, phase) === "done"
	).length;

	return (
		<div
			className={cn(DEMO_FRAME_CLASS, className)}
			data-testid="hierarchy-desktop-demo"
		>
			<DemoTitleBar
				title={openSession ? openSession.title : "Product launch"}
			/>
			<div className={DEMO_PANE_CLASS}>
				<DesktopShell
					navItems={[
						{ icon: PencilEdit01Icon, id: "new-chat", label: "New chat" },
						{
							icon: Search01Icon,
							id: "search",
							label: "Search",
							shortcut: "Ctrl K",
						},
					]}
					sidebarContent={
						<DemoSidebar
							phase={phase}
							view={openSession ? "session" : "project"}
						/>
					}
				>
					<div className="flex h-full min-h-0 flex-col">
						<div className="flex shrink-0 items-center justify-between gap-3 border-border/40 border-b px-4 py-2">
							<Crumbs
								items={
									openSession
										? [
												"Product launch",
												openSession.agent === "scout"
													? "Scout"
													: openSession.agent === "designer"
														? "Designer"
														: "QA",
												openSession.title,
											]
										: ["Product launch"]
								}
								onBack={() => setOpenSession(null)}
							/>
							<div className="relative flex shrink-0 items-center gap-1">
								{openSession ? null : (
									<span className="rounded-md px-2 py-1 text-xs hover:bg-muted">
										Sessions ({SESSIONS.length})
									</span>
								)}
								<button
									aria-expanded={defaultsOpen}
									className="rounded-md px-2 py-1 text-xs hover:bg-muted"
									onClick={() => setDefaultsOpen((current) => !current)}
									type="button"
								>
									Defaults
								</button>
								{defaultsOpen ? (
									<div className="absolute top-8 right-0 z-10 w-64 rounded-xl border border-border bg-popover p-3 text-left shadow-lg">
										<p className="font-medium text-sm">Model defaults</p>
										<p className="mt-1 text-muted-foreground text-xs">
											<span className="text-foreground">claude-sonnet</span>
											{" · "}
											{openSession
												? "Inherited from Scout in Product launch"
												: "Inherited from Product launch"}
										</p>
										<p className="mt-2 text-muted-foreground text-xs">
											The composer's model control overrides these for this
											session.
										</p>
									</div>
								) : null}
							</div>
						</div>
						<div className="scroll-fade no-scrollbar min-h-0 flex-1 space-y-4 overflow-auto px-6 py-5">
							{openSession ? (
								openSession.transcript.map((turn) =>
									turn.role === "user" ? (
										<UserBubble key={turn.text}>{turn.text}</UserBubble>
									) : (
										<AssistantText key={turn.text}>{turn.text}</AssistantText>
									)
								)
							) : (
								<>
									<UserBubble>Get the launch page ready for Friday.</UserBubble>
									<AssistantText>
										I split this into three sessions and assigned each to the
										right bot:
									</AssistantText>
									<div className="space-y-2">
										{SESSIONS.map((session, index) => (
											<SessionCardTool
												key={session.id}
												part={sessionPart(session, sessionState(index, phase))}
											/>
										))}
									</div>
									{phase >= 4 ? (
										<AssistantText>
											All {done} sessions are done. The page is ready for review
											— want me to schedule the launch post?
										</AssistantText>
									) : null}
								</>
							)}
						</div>
						<Composer
							placeholder={
								openSession
									? `Message ${openSession.title}…`
									: "Message Product launch…"
							}
						/>
					</div>
				</DesktopShell>
			</div>
		</div>
	);
}
