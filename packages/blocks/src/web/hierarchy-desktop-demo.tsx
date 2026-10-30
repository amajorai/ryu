"use client";

// The home-page hero's live demo of the desktop's Projects › Bots/Groups ›
// Sessions layout. It is built from the same pieces the desktop renders: the
// shared `DesktopShell` window chrome and `@ryu/ui` sidebar primitives, the
// messaging-style rows, the thread hierarchy bar, and the REAL `SessionCardTool`
// the desktop draws for a coordinator's `threads.*` calls. Data is static and
// nothing touches the network; a short scripted timeline moves the sessions from
// starting to done, and "Open session" switches the pane to that session.

import { PencilEdit01Icon, Search01Icon } from "@hugeicons/core-free-icons";
import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import { useEffect, useState } from "react";
import { SessionCardTool } from "../desktop/agent-elements/tools/session-card-tool.tsx";
import {
	OPEN_CONVERSATION_EVENT,
	type OpenConversationEvent,
} from "../desktop/agent-elements/tools/session-card-tool-logic.ts";
import { DesktopShell } from "../desktop/shell.tsx";
import {
	AssistantText,
	Composer,
	Crumbs,
	DEMO_FRAME_CLASS,
	DEMO_PANE_CLASS,
	DemoTitleBar,
	UserBubble,
	usePrefersReducedMotion,
} from "./hierarchy-desktop-demo-chrome.tsx";
import {
	type DemoSession,
	type Phase,
	SESSIONS,
	sessionPart,
	sessionState,
} from "./hierarchy-desktop-demo-data.ts";
import { DemoSidebar } from "./hierarchy-desktop-demo-sidebar.tsx";

/**
 * A pixel-faithful, interactive demo of the desktop's Projects › Bots/Groups ›
 * Sessions UI for the landing hero.
 */
export function HierarchyDesktopDemo({ className }: { className?: string }) {
	const tl = useLiteralMessages();
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
										{tl("Sessions ({length})", { length: SESSIONS.length })}
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
											{tl(
												"All {done} sessions are done. The page is ready for review — want me to schedule the launch post?",
												{ done }
											)}
										</AssistantText>
									) : null}
								</>
							)}
						</div>
						<Composer
							placeholder={
								openSession
									? tl("Message {title}…", { title: openSession.title })
									: "Message Product launch…"
							}
						/>
					</div>
				</DesktopShell>
			</div>
		</div>
	);
}
