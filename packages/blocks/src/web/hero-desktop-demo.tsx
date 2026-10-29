"use client";

import type { ChatStatus, UIMessage } from "ai";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useState } from "react";
import { AgentChat } from "../desktop/agent-elements/agent-chat.tsx";
import { DesktopShell } from "../desktop/shell.tsx";
import styles from "./hero-desktop-demo.module.css";

const RUNS = [
	{
		answer:
			"I found the latest project notes, drafted the update, and left the final send for your approval.",
		prompt: "Prepare a weekly update from the project folder.",
	},
	{
		answer:
			"I pulled the open items together and saved a short review list in your workspace.",
		prompt: "What still needs my attention this week?",
	},
] as const;

const textMessage = (
	id: string,
	role: "user" | "assistant",
	text: string
): UIMessage => ({ id, role, parts: [{ type: "text", text }] });

export default function HeroDesktopDemo() {
	const reduceMotion = useReducedMotion();
	const [runIndex, setRunIndex] = useState(0);
	const run = RUNS[runIndex] ?? RUNS[0];
	const messages = [
		textMessage("hero-user", "user", run.prompt),
		textMessage("hero-assistant", "assistant", run.answer),
	];

	useEffect(() => {
		if (reduceMotion) {
			setRunIndex(0);
			return;
		}

		const timer = window.setInterval(() => {
			setRunIndex((current) => (current + 1) % RUNS.length);
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
						key={run.prompt}
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
