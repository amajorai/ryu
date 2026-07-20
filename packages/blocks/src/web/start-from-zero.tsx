"use client";

import { cn } from "@ryu/ui/lib/utils";
import { motion } from "motion/react";
import { useEffect, useState } from "react";
import { SubscriptionProvidersGrid } from "./bring-your-subscription.tsx";
import { landingSubheadlineBodyClass } from "./landing-typography.ts";
import { Reveal } from "./reveal.tsx";
import { SectionTitle } from "./section-title.tsx";

const HISTORY = [
	{ src: "Claude", text: "Refactored the auth module" },
	{ src: "Codex", text: "Wrote the migration script" },
	{ src: "Claude", text: "Debugged the failing test" },
] as const;

export default function StartFromZero() {
	return (
		<section className="container mx-auto px-4 py-16 md:py-24">
			<div className="mx-auto grid max-w-6xl items-center gap-10 lg:grid-cols-2">
				<div className="space-y-5">
					<SectionTitle title="Your agent picks up where you left off." />
					<p className={cn(landingSubheadlineBodyClass, "max-w-md")}>
						Bring your Claude and Codex conversations — and the plans you
						already pay for. Ryu starts with context, not a blank slate.
					</p>
					<ul className="space-y-2.5">
						{[
							"Import conversations from the agents you already use",
							"Shared long-term memory across every surface",
							"Switch models mid-thread without losing the thread",
						].map((b) => (
							<li
								className="flex items-start gap-2.5 text-foreground/80 text-sm"
								key={b}
							>
								<span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-foreground/40" />
								{b}
							</li>
						))}
					</ul>
				</div>

				<Reveal delay={0.1}>
					<ImportViz />
				</Reveal>
			</div>

			<div className="mx-auto mt-16 max-w-6xl md:mt-24">
				<SubscriptionProvidersGrid />
			</div>
		</section>
	);
}

function ImportViz() {
	const [n, setN] = useState(0);

	useEffect(() => {
		const t = setInterval(() => {
			setN((v) => (v >= HISTORY.length ? 0 : v + 1));
		}, 1100);
		return () => clearInterval(t);
	}, []);

	return (
		<div className="rounded-3xl bg-muted/50 p-4">
			<div className="mb-4 flex items-center gap-2">
				<span className="size-2 rounded-full bg-foreground/30" />
				<span className="text-[11px] text-foreground/50 uppercase tracking-widest">
					Importing context
				</span>
			</div>

			<div className="flex flex-col gap-2">
				{HISTORY.map((h, i) => {
					const shown = i < n;
					return (
						<motion.div
							animate={{
								opacity: shown ? 1 : 0.25,
								x: shown ? 0 : -8,
							}}
							className="flex items-center gap-3 rounded-xl bg-foreground/5 px-3 py-2.5"
							key={h.text}
							transition={{ duration: 0.4 }}
						>
							<span className="rounded-md bg-foreground/10 px-2 py-0.5 font-medium text-[10px] text-foreground/60">
								{h.src}
							</span>
							<span className="text-foreground/70 text-xs">{h.text}</span>
							{shown ? (
								<motion.span
									animate={{ scale: 1 }}
									className="ml-auto text-foreground/40 text-xs"
									initial={{ scale: 0 }}
								>
									✓
								</motion.span>
							) : null}
						</motion.div>
					);
				})}
			</div>

			<div className="my-3 flex justify-center">
				<div className="h-4 w-px bg-foreground/15" />
			</div>

			<motion.div
				animate={{
					backgroundColor:
						n >= HISTORY.length
							? "var(--color-foreground)"
							: "color-mix(in oklch, var(--color-foreground) 6%, transparent)",
					color:
						n >= HISTORY.length
							? "var(--color-background)"
							: "color-mix(in oklch, var(--color-foreground) 70%, transparent)",
				}}
				className="rounded-xl px-4 py-3 text-center font-medium text-sm"
			>
				Ryu continues the thread →
			</motion.div>
		</div>
	);
}
