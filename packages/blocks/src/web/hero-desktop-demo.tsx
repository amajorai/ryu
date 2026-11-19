"use client";

import { type LiteralMessage, useLiteralMessages } from "@ryu/i18n/react";
import type { ChatStatus, UIMessage } from "ai";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useState } from "react";
import { AgentChat } from "../desktop/agent-elements/agent-chat.tsx";
import { DesktopShell } from "../desktop/shell.tsx";
import styles from "./hero-desktop-demo.module.css";

/**
 * The demo's two exchanges, translated before they become chat messages: the
 * chat renders each message through Markdown with the DOM localizer off, so
 * an English source would stay English in every language.
 */
export function heroDemoRuns(
	tl: LiteralMessage
): readonly { answer: string; prompt: string }[] {
	return [
		{
			answer: tl(
				"I found the latest project notes, drafted the update, and left the final send for your approval."
			),
			prompt: tl("Prepare a weekly update from the project folder."),
		},
		{
			answer: tl(
				"I pulled the open items together and saved a short review list in your workspace."
			),
			prompt: tl("What still needs my attention this week?"),
		},
	];
}

const RUN_COUNT = heroDemoRuns((source) => source).length;

const textMessage = (
	id: string,
	role: "user" | "assistant",
	text: string
): UIMessage => ({ id, role, parts: [{ type: "text", text }] });

export default function HeroDesktopDemo() {
	const tl = useLiteralMessages();
	const reduceMotion = useReducedMotion();
	const [runIndex, setRunIndex] = useState(0);
	const runs = heroDemoRuns(tl);
	const run = runs[runIndex] ?? runs[0];
	const messages = run
		? [
				textMessage("hero-user", "user", run.prompt),
				textMessage("hero-assistant", "assistant", run.answer),
			]
		: [];

	useEffect(() => {
		if (reduceMotion) {
			setRunIndex(0);
			return;
		}

		const timer = window.setInterval(() => {
			setRunIndex((current) => (current + 1) % RUN_COUNT);
		}, 5200);

		return () => window.clearInterval(timer);
	}, [reduceMotion]);

	const onSend = (_message: { role: "user"; content: string }) => undefined;
	const status: ChatStatus = "ready";

	return (
		<div
			className={`relative isolate overflow-hidden rounded-2xl ${styles.artwork} bg-center bg-cover p-3 md:p-5`}
			data-testid="hero-desktop-demo"
		>
			<div
				aria-hidden="true"
				className={`${styles.grid} pointer-events-none absolute inset-0`}
			/>
			<div className="type-compact relative z-10 flex items-center justify-between px-1 pb-3 text-muted-foreground/75 uppercase tracking-(--tracking-section)">
				<span>Bot</span>
				<span>Give it a task</span>
			</div>
			<div className="relative z-10 overflow-hidden rounded-xl bg-background">
				<AnimatePresence initial={false} mode="wait">
					<motion.div
						animate={{ opacity: 1 }}
						exit={{ opacity: 0 }}
						initial={{ opacity: 0 }}
						key={runIndex}
					>
						<DesktopShell sidebarMode="trust">
							<AgentChat
								messages={messages}
								onSend={onSend}
								onStop={() => undefined}
								status={status}
							/>
						</DesktopShell>
					</motion.div>
				</AnimatePresence>
			</div>
		</div>
	);
}
