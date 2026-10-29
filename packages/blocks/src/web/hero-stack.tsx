"use client";

import { cn } from "@ryu/ui/lib/utils";
import { AnimatePresence, MotionConfig, motion } from "motion/react";
import { useCallback, useEffect, useRef, useState } from "react";
import styles from "./hero-stack.module.css";

const SURFACES = [
	{ id: "desktop", label: "Desktop" },
	{ id: "mobile", label: "Mobile" },
	{ id: "cli", label: "CLI" },
	{ id: "bots", label: "Bots" },
	{ id: "api", label: "API" },
] as const;

const CONCERNS = [
	"Security",
	"Routing",
	"Memory",
	"Tools",
	"Skills",
	"MCP",
	"Budget",
] as const;

const ENGINES = [
	{ id: "local", label: "Local", tone: "Gemma · llama.cpp" },
	{ id: "openai", label: "OpenAI", tone: "GPT" },
	{ id: "claude", label: "Claude", tone: "Anthropic" },
	{ id: "gemini", label: "Gemini", tone: "Google" },
	{ id: "openclaw", label: "OpenClaw", tone: "OSS" },
] as const;

type Phase = "idle" | "up" | "route" | "down" | "back";

export default function HeroStack() {
	const [surface, setSurface] = useState(0);
	const [engine, setEngine] = useState(0);
	const [phase, setPhase] = useState<Phase>("idle");
	const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

	const clearTimers = useCallback(() => {
		for (const t of timers.current) {
			clearTimeout(t);
		}
		timers.current = [];
	}, []);

	const run = useCallback(
		(surfaceIndex: number, engineIndex?: number) => {
			clearTimers();
			const target = engineIndex ?? Math.floor((surfaceIndex * 7) % 5);
			setSurface(surfaceIndex);
			setEngine(target);
			setPhase("up");
			timers.current.push(setTimeout(() => setPhase("route"), 650));
			timers.current.push(setTimeout(() => setPhase("down"), 1500));
			timers.current.push(setTimeout(() => setPhase("back"), 2200));
			timers.current.push(setTimeout(() => setPhase("idle"), 3000));
		},
		[clearTimers]
	);

	// Auto-cycle through surfaces.
	useEffect(() => {
		let i = 0;
		run(0);
		const loop = setInterval(() => {
			i = (i + 1) % SURFACES.length;
			run(i);
		}, 3400);
		return () => {
			clearInterval(loop);
			clearTimers();
		};
	}, [run, clearTimers]);

	const upActive = phase === "up";
	const routeActive = phase === "route";
	const downActive = phase === "down";
	const backActive = phase === "back";

	return (
		<MotionConfig reducedMotion="user">
			<div className="mx-auto w-full max-w-3xl select-none rounded-3xl bg-muted/40 p-5 backdrop-blur-sm md:p-8">
				{/* Surfaces row */}
				<div className="mb-2 flex flex-wrap items-center justify-center gap-2">
					{SURFACES.map((s, i) => {
						const active = i === surface;
						return (
							<button
								aria-pressed={active}
								className={cn(
									"rounded-full px-3.5 py-1.5 font-medium text-xs transition-colors duration-300",
									active
										? "bg-foreground text-background"
										: "bg-muted/60 text-foreground/55 hover:bg-muted/80"
								)}
								key={s.id}
								onClick={() => run(i)}
								type="button"
							>
								{s.label}
							</button>
						);
					})}
				</div>

				{/* Up channel */}
				<Channel
					active={upActive || backActive}
					dir={backActive ? "down" : "up"}
					label="request"
				/>

				{/* Core + Gateway */}
				<div className="relative overflow-hidden rounded-2xl bg-foreground/5 p-4 md:p-5">
					<motion.div
						animate={{
							opacity: routeActive ? 0.5 : 0.16,
							scale: routeActive ? 1.04 : 1,
						}}
						className={`pointer-events-none absolute inset-0 -z-0 ${styles.glow}`}
						transition={{ duration: 0.6, ease: "easeInOut" }}
					/>
					<div className="relative z-10">
						<div className="mb-3 flex items-center justify-center gap-2">
							<span className="type-caption font-medium text-foreground uppercase tracking-(--tracking-section)">
								Ryu Core + Gateway
							</span>
							<AnimatePresence>
								{routeActive ? (
									<motion.span
										animate={{ opacity: 1, scale: 1 }}
										className="type-compact rounded-full bg-foreground px-2 py-0.5 font-medium text-background"
										exit={{ opacity: 0, scale: 0.9 }}
										initial={{ opacity: 0, scale: 0.9 }}
										key="routing"
									>
										routing →
									</motion.span>
								) : null}
							</AnimatePresence>
						</div>
						<div className="flex flex-wrap justify-center gap-1.5">
							{CONCERNS.map((c, i) => (
								<motion.span
									animate={{
										backgroundColor: routeActive
											? "color-mix(in oklch, var(--color-foreground) 14%, transparent)"
											: "color-mix(in oklch, var(--color-foreground) 6%, transparent)",
									}}
									className="type-caption rounded-md px-2.5 py-1 text-foreground/70"
									key={c}
									transition={{
										duration: 0.4,
										delay: routeActive ? i * 0.05 : 0,
									}}
								>
									{c}
								</motion.span>
							))}
						</div>
					</div>
				</div>

				{/* Down channel */}
				<Channel
					active={downActive}
					dir="down"
					label="cheapest capable model"
				/>

				{/* Engines row */}
				<div className="flex flex-wrap items-center justify-center gap-2">
					{ENGINES.map((e, i) => {
						const active = i === engine && (downActive || backActive);
						return (
							<motion.div
								animate={{
									backgroundColor: active
										? "var(--color-foreground)"
										: "color-mix(in oklch, var(--color-foreground) 6%, transparent)",
									color: active
										? "var(--color-background)"
										: "color-mix(in oklch, var(--color-foreground) 55%, transparent)",
								}}
								className="flex flex-col items-center rounded-xl px-3 py-1.5"
								key={e.id}
								transition={{ duration: 0.3 }}
							>
								<span className="font-medium text-xs">{e.label}</span>
								<span className="type-compact opacity-60">{e.tone}</span>
							</motion.div>
						);
					})}
				</div>
			</div>
		</MotionConfig>
	);
}

function Channel({
	active,
	dir,
	label,
}: {
	active: boolean;
	dir: "up" | "down";
	label: string;
}) {
	return (
		<div className="relative my-2 flex h-7 items-center justify-center">
			<div className="h-full w-px bg-foreground/12" />
			<AnimatePresence>
				{active ? (
					<>
						<motion.span
							animate={{ y: dir === "up" ? -14 : 14, opacity: [0, 1, 0] }}
							className="absolute h-1.5 w-1.5 rounded-full bg-foreground"
							exit={{ opacity: 0 }}
							initial={{ y: dir === "up" ? 14 : -14, opacity: 0 }}
							key="dot"
							transition={{ duration: 0.6, ease: "easeInOut" }}
						/>
						<motion.span
							animate={{ opacity: 1, x: 0 }}
							className="type-compact absolute left-[calc(50%+0.75rem)] whitespace-nowrap text-foreground/40"
							exit={{ opacity: 0 }}
							initial={{ opacity: 0, x: -4 }}
							key="label"
							transition={{ duration: 0.3 }}
						>
							{label}
						</motion.span>
					</>
				) : null}
			</AnimatePresence>
		</div>
	);
}
