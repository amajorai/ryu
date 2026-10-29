import { threadStatus } from "@ryuhq/protocol/interfaces";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { isInterfaceCovered } from "./interface-keys.ts";
import {
	agentById,
	type InterfaceRendererProps,
} from "./interface-renderer.ts";
import { PersonaActivity } from "./persona-activity.tsx";
import { PersonaChat } from "./persona-chat.tsx";
import { PersonaContext } from "./persona-context.tsx";
import { type FeedScope, PersonaFeed } from "./persona-feed.tsx";
import { PersonaGoals } from "./persona-goals.tsx";
import { PersonaHeader } from "./persona-header.tsx";
import { PersonaIdeas } from "./persona-ideas.tsx";
import {
	defaultPersonaId,
	mainThread,
	type PersonaGoal,
	type PersonaTab,
	personaActivity,
	personaForThread,
	personaGoals,
	personaIdeas,
	personaStatus,
	personaThreads,
	projectFeed,
	type StatusDepth,
	sideChats,
} from "./persona-model.ts";
import {
	PersonaRail,
	PersonaTabBar,
	personaPanelId,
	personaTabId,
} from "./persona-nav.tsx";
import { PersonaEmpty, PersonaSkeleton } from "./persona-states.tsx";

/**
 * Persona: a chat-first personal-agent app. You pick one agent as your
 * persona; its face, name and a three-layer status line sit on top, and a
 * rail (a bottom tab bar on phones) switches between Chat, Feed, Ideas,
 * Goals and Activity. Chat frames the host's own conversation surface, with
 * the persona's other threads as side chats above it.
 */
export function PersonaInterface({
	activeThreadId,
	loading,
	port,
	snapshot,
	threadView,
}: InterfaceRendererProps<Record<string, never>>) {
	const [chosenId, setChosenId] = useState<string | null>(null);
	const [tab, setTab] = useState<PersonaTab>("chat");
	const [depth, setDepth] = useState<StatusDepth>(0);
	const [composing, setComposing] = useState(false);
	const [chatDraft, setChatDraft] = useState("");
	const [ideaDraft, setIdeaDraft] = useState("");
	const [feedScope, setFeedScope] = useState<FeedScope>("everyone");
	const [focusField, setFocusField] = useState<"chat" | "idea" | null>(null);
	const chatFieldRef = useRef<HTMLTextAreaElement>(null);
	const ideaFieldRef = useRef<HTMLTextAreaElement>(null);
	const rootRef = useRef<HTMLDivElement>(null);
	const autoOpened = useRef(false);

	// Move focus into a composer after the render that shows it, so a new
	// side chat or a picked idea is ready to edit and send.
	useEffect(() => {
		if (!focusField) {
			return;
		}
		const field =
			focusField === "chat" ? chatFieldRef.current : ideaFieldRef.current;
		if (field) {
			field.focus();
			const end = field.value.length;
			field.setSelectionRange(end, end);
		}
		setFocusField(null);
	}, [focusField]);

	const activeThread = activeThreadId
		? snapshot.threads.find((thread) => thread.id === activeThreadId)
		: undefined;
	const fallbackId = useMemo(() => defaultPersonaId(snapshot), [snapshot]);
	const chosen =
		chosenId && agentById(snapshot, chosenId) ? chosenId : fallbackId;
	const personaId = personaForThread(snapshot, activeThread, chosen);
	const persona = agentById(snapshot, personaId);

	// A thread opened anywhere (here, a notification, another surface) brings
	// Chat forward with its persona, so the host's chat is never hidden.
	const threadOpen = threadView !== null;
	const openPersonaId = activeThread ? personaId : null;
	useEffect(() => {
		if (!threadOpen) {
			return;
		}
		setTab("chat");
		setComposing(false);
		if (openPersonaId) {
			setChosenId(openPersonaId);
		}
	}, [threadOpen, openPersonaId]);

	const threads = useMemo(
		() => personaThreads(snapshot, personaId),
		[snapshot, personaId]
	);
	const main = mainThread(threads, personaId);
	// A thread the persona is not part of (an unassigned one, say) still gets
	// a chip while it is open, so the strip always names what is showing.
	const ownSides = sideChats(threads, main);
	const sides =
		activeThread && !threads.includes(activeThread)
			? [activeThread, ...ownSides]
			: ownSides;
	// A wide window lands in the persona's main chat with its history, the
	// way a messaging app reopens the last conversation. Once, after the
	// first load, and never over a thread the host already opened or a page
	// the host shows over the interface.
	const mainId = main?.id ?? null;
	useEffect(() => {
		if (autoOpened.current || loading) {
			return;
		}
		autoOpened.current = true;
		if (isInterfaceCovered(rootRef.current)) {
			return;
		}
		const wide = (rootRef.current?.clientWidth ?? 0) >= 900;
		if (wide && mainId && !threadOpen) {
			port.openThread(mainId);
		}
	}, [loading, mainId, port, threadOpen]);

	const suggestions = useMemo(
		() => personaIdeas(persona, threads).flatMap((group) => group.ideas),
		[persona, threads]
	);

	// Goals the persona is part of lead the context column's preview.
	const contextGoals = useMemo(() => {
		const { projects, teams } = personaGoals(snapshot, persona?.id ?? null);
		return [...projects, ...teams].sort(
			(a, b) => Number(b.includesPersona) - Number(a.includesPersona)
		);
	}, [snapshot, persona?.id]);

	const status = useMemo(
		() => personaStatus(persona, threads),
		[persona, threads]
	);
	const headlines = useMemo(() => {
		const map = new Map<string, string>();
		for (const agent of snapshot.agents) {
			map.set(
				agent.id,
				personaStatus(agent, personaThreads(snapshot, agent.id)).headline
			);
		}
		return map;
	}, [snapshot]);
	const badges = useMemo(
		() => ({
			attention: snapshot.threads.filter(
				(thread) => threadStatus(thread) === "attention"
			).length,
			unread: threads.filter((thread) => threadStatus(thread) === "your-turn")
				.length,
		}),
		[snapshot.threads, threads]
	);

	const selectPersona = (agentId: string) => {
		setChosenId(agentId);
		setDepth(0);
		setComposing(false);
		setChatDraft("");
		if (threadOpen) {
			port.closeThread();
		}
	};
	const openThread = (threadId: string) => {
		setComposing(false);
		setTab("chat");
		if (threadId !== activeThreadId) {
			port.openThread(threadId);
		}
	};
	const newSideChat = () => {
		setTab("chat");
		setComposing(true);
		if (threadOpen) {
			port.closeThread();
		}
		setFocusField("chat");
	};
	const send = (prompt: string) => {
		if (!persona) {
			return;
		}
		setComposing(false);
		setChatDraft("");
		setIdeaDraft("");
		setTab("chat");
		port.startThread({ agentId: persona.id, prompt });
	};
	const suggest = (prompt: string) => {
		setChatDraft(prompt);
		newSideChat();
	};
	const pickIdea = (prompt: string) => {
		setIdeaDraft(prompt);
		setFocusField("idea");
	};
	const newGoalChat = (goal: PersonaGoal) => {
		setTab("chat");
		if (goal.group.kind === "team") {
			port.startThread({ teamId: goal.group.id });
			return;
		}
		port.startThread({
			agentId: persona && goal.includesPersona ? persona.id : undefined,
			projectId: goal.group.id,
		});
	};

	const root = (children: ReactNode) => (
		<div
			className="@container flex size-full min-h-0 overflow-hidden bg-background text-foreground"
			data-testid="interface-persona"
			ref={rootRef}
		>
			{children}
		</div>
	);

	if (!persona) {
		return root(
			loading ? <PersonaSkeleton /> : <PersonaEmpty threadView={threadView} />
		);
	}

	let panel: ReactNode;
	if (tab === "feed") {
		panel = (
			<PersonaFeed
				days={projectFeed(
					snapshot,
					feedScope === "persona" ? persona.id : null
				)}
				onOpen={openThread}
				onScopeChange={setFeedScope}
				persona={persona}
				scope={feedScope}
				snapshot={snapshot}
			/>
		);
	} else if (tab === "ideas") {
		panel = (
			<PersonaIdeas
				agent={persona}
				draft={ideaDraft}
				fieldRef={ideaFieldRef}
				groups={personaIdeas(persona, threads)}
				onDraftChange={setIdeaDraft}
				onPick={pickIdea}
				onSend={send}
			/>
		);
	} else if (tab === "goals") {
		panel = (
			<PersonaGoals
				goals={personaGoals(snapshot, persona.id)}
				onNewChat={newGoalChat}
				onOpen={openThread}
				snapshot={snapshot}
			/>
		);
	} else if (tab === "activity") {
		panel = (
			<PersonaActivity
				activity={personaActivity(snapshot)}
				onOpen={openThread}
				snapshot={snapshot}
			/>
		);
	} else {
		panel = (
			<PersonaChat
				activeThreadId={activeThreadId}
				agent={persona}
				composing={composing}
				draft={chatDraft}
				fieldRef={chatFieldRef}
				main={main}
				onCancelCompose={() => setComposing(false)}
				onClose={port.closeThread}
				onDraftChange={setChatDraft}
				onNewSideChat={newSideChat}
				onOpen={openThread}
				onSend={send}
				onSuggest={suggest}
				sides={sides}
				suggestions={suggestions}
				threadView={threadView}
			/>
		);
	}

	return root(
		<>
			<PersonaRail
				agents={snapshot.agents}
				badges={badges}
				headlines={headlines}
				onSelectPersona={selectPersona}
				onSelectTab={setTab}
				personaId={persona.id}
				tab={tab}
			/>
			<div className="flex min-h-0 min-w-0 flex-1 flex-col">
				<PersonaHeader
					agent={persona}
					agents={snapshot.agents}
					compact={tab === "chat" && threadOpen}
					depth={depth}
					joined={tab === "chat"}
					onDepthChange={setDepth}
					onOpenThread={openThread}
					onSelectPersona={selectPersona}
					status={status}
				/>
				<div
					aria-labelledby={personaTabId(tab)}
					className="flex min-h-0 flex-1 flex-col"
					id={personaPanelId(tab)}
					role="tabpanel"
				>
					{panel}
				</div>
				<PersonaTabBar badges={badges} onSelectTab={setTab} tab={tab} />
			</div>
			{tab === "chat" ? (
				<PersonaContext
					activeThreadId={activeThreadId}
					goals={contextGoals}
					ideas={suggestions}
					now={Date.now()}
					onNewSideChat={newSideChat}
					onOpen={openThread}
					onSelectTab={setTab}
					onSuggest={suggest}
					sides={sides}
					threads={threads}
				/>
			) : null}
		</>
	);
}
