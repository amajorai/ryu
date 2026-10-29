import { cn } from "@ryu/ui/lib/utils.ts";
import type {
	InterfaceParamsByRenderer,
	InterfaceThread,
} from "@ryuhq/protocol/interfaces";
import { motion } from "motion/react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { isInterfaceCovered } from "./interface-keys.ts";
import type { InterfaceRendererProps } from "./interface-renderer.ts";
import {
	MessengerCompose,
	MessengerConversation,
	MessengerWelcome,
} from "./messenger-conversation.tsx";
import { MessengerContactList } from "./messenger-list.tsx";
import {
	canStartWith,
	entryForThread,
	filterMessengerEntries,
	type MessengerEntry,
	projectMessengerEntries,
} from "./messenger-model.ts";
import { useReducedMotion } from "./reduced-motion.ts";

/**
 * Messenger: agents (and teams, as group chats) as contacts, like a desktop
 * messaging app. The left rail lists contacts by most recent conversation;
 * the right column shows the selected contact's conversations and the host's
 * real chat surface for the open one. Below 900px wide it becomes a
 * list/detail flow with a back button.
 */
export function MessengerInterface({
	activeThreadId,
	loading,
	port,
	snapshot,
	threadView,
}: InterfaceRendererProps<InterfaceParamsByRenderer["messenger"]>) {
	const [query, setQuery] = useState("");
	const [selectedKey, setSelectedKey] = useState<string | null>(null);
	const [composing, setComposing] = useState(false);
	const searchRef = useRef<HTMLInputElement>(null);
	const rootRef = useRef<HTMLDivElement>(null);
	const autoOpened = useRef(false);
	const reduceMotion = useReducedMotion();

	// A thread opened from elsewhere (a notification, another surface) wins
	// over an unsent "New message", so the host's chat is never hidden.
	useEffect(() => {
		if (activeThreadId) {
			setComposing(false);
		}
	}, [activeThreadId]);

	const entries = useMemo(() => projectMessengerEntries(snapshot), [snapshot]);
	const visible = useMemo(
		() => filterMessengerEntries(entries, query),
		[entries, query]
	);
	const recipients = useMemo(() => entries.filter(canStartWith), [entries]);
	const threadsById = useMemo(
		() => new Map(snapshot.threads.map((thread) => [thread.id, thread])),
		[snapshot.threads]
	);

	// Like a desktop messaging app, a wide window opens on the most recent
	// conversation instead of a blank pane. Once, after the first load, and
	// never over a thread the host already opened, a page the host shows over
	// the interface, or in the narrow list view.
	useEffect(() => {
		if (autoOpened.current || loading) {
			return;
		}
		autoOpened.current = true;
		if (
			activeThreadId ||
			threadView !== null ||
			isInterfaceCovered(rootRef.current)
		) {
			return;
		}
		const wide = (rootRef.current?.clientWidth ?? 0) >= 900;
		const latest = entries.find((entry) => entry.lastThreadId);
		if (wide && latest?.lastThreadId) {
			setSelectedKey(latest.key);
			port.openThread(latest.lastThreadId);
		}
	}, [activeThreadId, entries, loading, port, threadView]);

	const activeThread = activeThreadId
		? threadsById.get(activeThreadId)
		: undefined;
	// The open thread decides the contact; with none open, the user's pick does.
	const selected = activeThread
		? entryForThread(entries, activeThread, selectedKey)
		: entries.find((entry) => entry.key === selectedKey);
	const selectedThreads = (selected?.threadIds ?? [])
		.map((id) => threadsById.get(id))
		.filter((thread): thread is InterfaceThread => thread !== undefined);

	const detailOpen = composing || selected !== undefined || threadView !== null;

	const select = (entry: MessengerEntry, threadId?: string) => {
		setComposing(false);
		setSelectedKey(entry.key);
		const target = threadId ?? entry.lastThreadId;
		if (target) {
			if (target !== activeThreadId) {
				port.openThread(target);
			}
			return;
		}
		// No history: leave whatever is open so the empty conversation shows.
		if (threadView !== null) {
			port.closeThread();
		}
	};

	const startWith = (entry: MessengerEntry, prompt?: string) => {
		if (!canStartWith(entry)) {
			return;
		}
		setComposing(false);
		setSelectedKey(entry.key);
		port.startThread(
			entry.kind === "team"
				? { prompt, teamId: entry.id }
				: { agentId: entry.id, prompt }
		);
	};

	const back = () => {
		setComposing(false);
		setSelectedKey(null);
		if (threadView !== null) {
			port.closeThread();
		}
	};

	// The pane fades in when what it shows changes, not on every thread switch.
	let paneKey = "welcome";
	if (composing) {
		paneKey = "compose";
	} else if (selected) {
		paneKey = selected.key;
	} else if (threadView) {
		paneKey = "thread";
	}
	let detail: ReactNode;
	if (composing) {
		detail = (
			<MessengerCompose
				entries={recipients}
				initialKey={selected && canStartWith(selected) ? selected.key : null}
				onBack={back}
				onSend={startWith}
			/>
		);
	} else if (selected || threadView) {
		detail = (
			<MessengerConversation
				activeThread={activeThread}
				entry={selected}
				onBack={back}
				onNewConversation={(entry) => startWith(entry)}
				onOpenThread={port.openThread}
				onSend={startWith}
				threads={selectedThreads}
				threadView={threadView}
			/>
		);
	} else {
		detail = (
			<MessengerWelcome hasContacts={entries.length > 0} loading={loading} />
		);
	}

	return (
		<div
			className="@container flex size-full min-h-0 overflow-hidden bg-background text-foreground"
			data-testid="interface-messenger"
			ref={rootRef}
		>
			<div
				className={cn(
					"min-h-0 @min-[900px]:w-[340px] w-full shrink-0 @min-[900px]:border-sidebar-border @min-[900px]:border-r",
					detailOpen ? "@min-[900px]:block hidden" : "block"
				)}
			>
				<MessengerContactList
					composing={composing}
					entries={visible}
					loading={loading}
					onCompose={() => setComposing((open) => !open)}
					onQueryChange={setQuery}
					onSelect={select}
					query={query}
					searchRef={searchRef}
					selectedKey={selected?.key ?? null}
					totalCount={entries.length}
				/>
			</div>
			<div
				className={cn(
					"min-h-0 min-w-0 flex-1 flex-col bg-background",
					detailOpen ? "flex" : "@min-[900px]:flex hidden"
				)}
			>
				<motion.div
					animate={{ opacity: 1, y: 0 }}
					className="flex min-h-0 flex-1 flex-col"
					initial={reduceMotion ? false : { opacity: 0, y: 4 }}
					key={paneKey}
					transition={{ duration: 0.14, ease: "easeOut" }}
				>
					{detail}
				</motion.div>
			</div>
		</div>
	);
}
