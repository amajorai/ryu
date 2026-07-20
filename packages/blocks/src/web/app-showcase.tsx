"use client";

/*
 * Interactive 1:1 showcase of the Ryu desktop app for the landing page. This is
 * NOT a redrawn approximation: it composes the SAME real `DesktopShell`
 * (real @ryu/ui Sidebar + Logo + icons) wrapping the real `AgentChat`, driven by
 * local state so the composer echoes.
 *
 * The floating Island itself no longer lives here — it is now persistent site
 * chrome (`GlobalIsland`, mounted in the web root layout, visible on every page,
 * docked top-left where the header logo used to be). The state switcher below
 * drives that one shared instance through `island-store` so every morph state is
 * still reachable from the landing page.
 */

import { Badge } from "@ryu/ui/components/badge";
import { Button } from "@ryu/ui/components/button";
import type { ChatStatus, UIMessage } from "ai";
import { useCallback, useEffect, useRef, useState } from "react";
import { AgentChat } from "../desktop/agent-elements/agent-chat.tsx";
import { DesktopShell } from "../desktop/shell.tsx";
import { setIslandHasPromo } from "./island-store.ts";

/* ── desktop chat: real AgentChat driven by local state so the composer echoes ─ */

const textMessage = (
	id: string,
	role: "user" | "assistant",
	text: string
): UIMessage =>
	({
		id,
		role,
		parts: [{ type: "text", text }],
	}) as unknown as UIMessage;

const REFACTOR_PROMPT = "Can you refactor the auth flow to use device codes?";
const ASSISTANT_INTRO =
	"Sure. I'll read the current auth client, then add a device-code grant alongside the existing OAuth path.";
const DESKTOP_REPLIES = [
	"Done. The new flow polls `/device/token` until the user approves, and OAuth stays the default so existing sign-ins are untouched.",
	"I ran the test suite. All green. Want me to open a PR with these changes?",
];

function DesktopChatInteractive() {
	const [messages, setMessages] = useState<UIMessage[]>([
		textMessage("user-1", "user", REFACTOR_PROMPT),
		textMessage("assistant-1", "assistant", ASSISTANT_INTRO),
	]);
	const [status, setStatus] = useState<ChatStatus>("ready");
	const replyIndex = useRef(0);
	const idSeq = useRef(1);

	const onSend = useCallback((message: { role: "user"; content: string }) => {
		const trimmed = message.content.trim();
		if (!trimmed) {
			return;
		}
		idSeq.current += 1;
		setMessages((prev) => [
			...prev,
			textMessage(`user-${idSeq.current}`, "user", trimmed),
		]);
		setStatus("streaming");
		const reply = DESKTOP_REPLIES[replyIndex.current % DESKTOP_REPLIES.length];
		replyIndex.current += 1;
		setTimeout(() => {
			idSeq.current += 1;
			setMessages((prev) => [
				...prev,
				textMessage(`assistant-${idSeq.current}`, "assistant", reply),
			]);
			setStatus("ready");
		}, 650);
	}, []);

	return (
		<AgentChat
			messages={messages}
			onSend={onSend}
			onStop={() => setStatus("ready")}
			status={status}
		/>
	);
}

function Selector({ label, value }: { label: string; value: string }) {
	return (
		<button
			className="flex items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1.5 text-sm hover:bg-accent"
			type="button"
		>
			<span className="text-muted-foreground text-xs">{label}</span>
			<span className="font-medium">{value}</span>
			<span className="text-muted-foreground">⌄</span>
		</button>
	);
}

function ChatTopBar() {
	return (
		<header className="flex items-center gap-2 border-border border-b px-4 py-2.5">
			<Selector label="Agent" value="Ryu" />
			<Selector label="Model" value="claude-opus-4-8" />
			<Selector label="Project" value="ryu" />
			<div className="ml-auto flex items-center gap-2">
				<Badge variant="outline">main</Badge>
				<Button size="icon-sm" variant="ghost">
					⋯
				</Button>
			</div>
		</header>
	);
}

/* ── the composite: desktop window + the switcher that drives the global island ─ */

// The launch discount is a rare surprise: it only surfaces on ~1 in 10 loads.
const PROMO_CHANCE = 0.1;

export function AppShowcase() {
	// Rolled once on mount (client-only) so SSR/hydration stay in sync. Seeds the
	// persistent GlobalIsland (root layout) with whether the promo is available.
	useEffect(() => {
		setIslandHasPromo(Math.random() < PROMO_CHANCE);
	}, []);

	return (
		<div className="mx-auto w-full max-w-6xl">
			{/* Desktop window frame (frameless app look: rounded, ringed, shadowed). */}
			<div className="relative">
				<div className="relative h-[600px] overflow-hidden rounded-2xl bg-background shadow-2xl ring-1 ring-border">
					<DesktopShell>
						<ChatTopBar />
						<DesktopChatInteractive />
					</DesktopShell>
				</div>
			</div>
		</div>
	);
}

export default AppShowcase;
