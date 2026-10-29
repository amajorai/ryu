import {
	type ReactNode,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { isInterfaceCovered } from "./interface-keys.ts";
import type { InterfaceRendererProps } from "./interface-renderer.ts";
import { PanelsChatEmpty, PanelsChatOpen } from "./panels-chat.tsx";
import { PanelsHome } from "./panels-home.tsx";
import {
	type PanelsTarget,
	type PanelsTopic,
	type PanelsView,
	recentThreads,
} from "./panels-model.ts";
import {
	PanelsSidebar,
	PanelsTopBar,
	threadById,
	usePanelsClock,
} from "./panels-parts.tsx";
import { PanelsProjects } from "./panels-projects.tsx";

const SIDEBAR_RECENT = 8;

function isTypingTarget(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) {
		return false;
	}
	return (
		target.isContentEditable ||
		target.tagName === "INPUT" ||
		target.tagName === "TEXTAREA" ||
		target.tagName === "SELECT"
	);
}

/**
 * Panels: a calm personal-assistant shell after Hark. A left rail switches
 * between Home (one-tap suggestions and small tool panels over a sky for the
 * local time of day), Chat (one persistent conversation, the host's own
 * surface, large and centred), and Projects (each project and team as a
 * topic listing its conversations).
 */
export function PanelsInterface({
	activeThreadId,
	loading,
	port,
	snapshot,
	threadView,
}: InterfaceRendererProps<Record<string, never>>) {
	const now = usePanelsClock();
	const [view, setView] = useState<PanelsView>("home");
	const isOpen = threadView !== null && threadView !== undefined;
	const shown: PanelsView = isOpen ? "chat" : view;
	const openThread = threadById(snapshot, activeThreadId);
	const lastThreadRef = useRef<string | null>(null);
	useEffect(() => {
		if (activeThreadId) {
			lastThreadRef.current = activeThreadId;
		}
	}, [activeThreadId]);

	// The page to land on when the conversation closes: where the user was
	// before Chat, not Chat's own empty page.
	const returnViewRef = useRef<PanelsView>("home");
	const enterChat = () => {
		if (view !== "chat") {
			returnViewRef.current = view;
		}
		setView("chat");
	};
	const closeConversation = () => {
		if (view === "chat") {
			setView(returnViewRef.current);
		}
		port.closeThread();
	};

	const rootRef = useRef<HTMLDivElement>(null);
	const frameRef = useRef<HTMLDivElement>(null);
	const closeRef = useRef(closeConversation);
	const isOpenRef = useRef(isOpen);
	useLayoutEffect(() => {
		closeRef.current = closeConversation;
		isOpenRef.current = isOpen;
	});

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (isInterfaceCovered(rootRef.current)) {
				return;
			}
			if (
				event.key !== "Escape" ||
				event.defaultPrevented ||
				event.isComposing ||
				!isOpenRef.current ||
				isTypingTarget(event.target)
			) {
				return;
			}
			const target = event.target;
			// Inside the host's conversation its own keys win.
			if (target instanceof Node && frameRef.current?.contains(target)) {
				return;
			}
			const onPage =
				target === document.body ||
				target === document.documentElement ||
				(target instanceof Node && rootRef.current?.contains(target) === true);
			if (onPage) {
				event.preventDefault();
				closeRef.current();
			}
		};
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, []);

	const selectView = (next: PanelsView) => {
		if (next === "chat") {
			enterChat();
			if (isOpen) {
				return;
			}
			const remembered = threadById(snapshot, lastThreadRef.current);
			const target = remembered ?? recentThreads(snapshot, 1)[0];
			if (target) {
				port.openThread(target.id);
			}
			return;
		}
		setView(next);
		if (isOpen) {
			port.closeThread();
		}
	};

	const newChat = () => {
		enterChat();
		if (isOpen) {
			port.closeThread();
		}
	};

	const onTarget = (target: PanelsTarget) => {
		if (target.kind === "open") {
			port.openThread(target.threadId);
		} else {
			port.startThread({ agentId: target.agentId });
		}
	};

	const onStartInTopic = (topic: PanelsTopic) => {
		const group = topic.group;
		if (!group) {
			return;
		}
		port.startThread(
			group.kind === "project"
				? { agentId: topic.members[0]?.id, projectId: group.id }
				: { agentId: topic.members[0]?.id, teamId: group.id }
		);
	};

	const nowMs = now.getTime();
	let content: ReactNode;
	if (shown === "chat" && isOpen) {
		content = (
			<div className="size-full min-h-0" ref={frameRef}>
				<PanelsChatOpen
					now={nowMs}
					onClose={closeConversation}
					onNewChat={newChat}
					onOpenThread={(threadId) => port.openThread(threadId)}
					snapshot={snapshot}
					thread={openThread}
					threadView={threadView}
				/>
			</div>
		);
	} else if (shown === "chat") {
		content = (
			<div className="size-full overflow-y-auto">
				<PanelsChatEmpty
					now={nowMs}
					onOpenThread={(threadId) => port.openThread(threadId)}
					onStart={({ agentId, prompt }) =>
						port.startThread({ agentId, prompt })
					}
					snapshot={snapshot}
				/>
			</div>
		);
	} else if (shown === "projects") {
		content = (
			<div className="size-full overflow-y-auto">
				<PanelsProjects
					now={nowMs}
					onOpenThread={(threadId) => port.openThread(threadId)}
					onStart={onStartInTopic}
					snapshot={snapshot}
				/>
			</div>
		);
	} else {
		content = (
			<div className="size-full overflow-y-auto">
				<PanelsHome
					loading={loading}
					now={now}
					onNewChat={newChat}
					onTarget={onTarget}
					snapshot={snapshot}
				/>
			</div>
		);
	}

	return (
		<div
			aria-busy={loading || undefined}
			className="flex size-full min-h-0 bg-background text-foreground antialiased"
			data-state={isOpen ? "open" : "closed"}
			data-testid="interface-panels"
			data-view={shown}
			ref={rootRef}
		>
			<PanelsSidebar
				activeThreadId={activeThreadId}
				onNewChat={newChat}
				onOpenThread={(threadId) => port.openThread(threadId)}
				onSelectView={selectView}
				recent={recentThreads(snapshot, SIDEBAR_RECENT)}
				view={shown}
			/>
			<div className="flex min-w-0 flex-1 flex-col">
				<PanelsTopBar
					onNewChat={newChat}
					onSelectView={selectView}
					view={shown}
				/>
				<main className="@container relative min-h-0 flex-1">{content}</main>
			</div>
		</div>
	);
}
