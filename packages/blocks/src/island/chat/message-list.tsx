"use client";

// The island mini-chat transcript, rendered as plain text that blends into the
// island glass — no bubbles, no cards. Your turns read slightly dimmer than
// Ryu's replies; that role tint is the only styling. A streaming reply shows a
// minimal caret.

import { useEffect, useRef } from "react";

export interface IslandChatMessage {
	content: string;
	id: string;
	role: "assistant" | "user";
	/** True while the assistant message is still streaming tokens. */
	streaming?: boolean;
}

export function MessageList({
	messages = [],
}: {
	messages?: IslandChatMessage[];
}) {
	const endRef = useRef<HTMLDivElement | null>(null);

	// A cheap signal that changes on every new turn and every streamed token, so
	// the transcript auto-scrolls as content grows.
	const scrollSignal = messages.reduce(
		(total, message) => total + message.content.length,
		messages.length
	);

	// biome-ignore lint/correctness/useExhaustiveDependencies: scrollSignal is the intended trigger
	useEffect(() => {
		endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
	}, [scrollSignal]);

	// Empty transcripts render nothing: the composer is shown on its own (the
	// island stays a short bar until there is history).
	if (messages.length === 0) {
		return null;
	}

	return (
		<div className="flex flex-col gap-3 text-sm leading-relaxed">
			{messages.map((message) => (
				<p
					className={
						message.role === "user"
							? "whitespace-pre-wrap text-neutral-400"
							: "whitespace-pre-wrap text-neutral-100"
					}
					key={message.id}
				>
					{message.content}
					{message.streaming && message.content.length === 0 ? (
						<span className="text-neutral-500">…</span>
					) : null}
					{message.streaming && message.content.length > 0 ? (
						<span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse bg-neutral-400 align-middle" />
					) : null}
				</p>
			))}
			<div ref={endRef} />
		</div>
	);
}
