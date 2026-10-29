import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { cn } from "@ryu/ui/lib/utils";
import type {
	InterfaceAgent,
	InterfaceThread,
} from "@ryuhq/protocol/interfaces";
import { Pause, Play } from "lucide-react";
import { motion } from "motion/react";
import { useEffect, useMemo, useState } from "react";
import { liveArt, liveCaptionLines, liveSpeaker } from "./live-model.ts";
import { LiveBadge, LiveChip, LiveScreen } from "./live-parts.tsx";

/** Characters per caption line. */
const CAPTION_WIDTH = 60;
/** Milliseconds between caption words while live. */
const WORD_MS = 170;
/** Ticks a finished line holds before the next one starts. */
const LINE_HOLD = 8;

interface CaptionState {
	line: number;
	/** Words revealed on the current line; past its length counts the hold. */
	words: number;
}

function wordsOf(line: string | undefined): number {
	return line ? line.split(" ").length : 0;
}

/**
 * Closed captions of the newest message. While the stream is live they roll
 * in word by word, a line at a time, with the previous line above; the last
 * line stays with a blinking caret until the next message arrives. Paused,
 * offline, or with reduced motion, the final two lines show as they are.
 */
function LiveCaptions({
	animate,
	live,
	speaker,
	text,
}: {
	animate: boolean;
	live: boolean;
	speaker: string;
	text: string;
}) {
	const lines = useMemo(() => liveCaptionLines(text, CAPTION_WIDTH), [text]);
	const lastLine = Math.max(0, lines.length - 1);
	const [state, setState] = useState<CaptionState>({ line: 0, words: 0 });

	useEffect(() => {
		setState({ line: 0, words: 0 });
	}, [text]);

	useEffect(() => {
		if (!animate) {
			return;
		}
		const timer = window.setInterval(() => {
			if (document.visibilityState === "hidden") {
				return;
			}
			setState((previous) => {
				const total = wordsOf(lines[previous.line]);
				if (previous.words < total + LINE_HOLD) {
					if (previous.line === lastLine && previous.words >= total) {
						return previous;
					}
					return { ...previous, words: previous.words + 1 };
				}
				return previous.line < lastLine
					? { line: previous.line + 1, words: 0 }
					: previous;
			});
		}, WORD_MS);
		return () => window.clearInterval(timer);
	}, [animate, lastLine, lines]);

	const settled = !animate;
	const current = lines[state.line] ?? "";
	const shown = current.split(" ").slice(0, state.words).join(" ");
	const previous = state.line > 0 ? lines[state.line - 1] : null;
	const typing = live && !settled;

	return (
		<div
			aria-hidden="true"
			className="absolute inset-x-0 bottom-[7%] flex justify-center px-[8%]"
		>
			<div className="flex w-full max-w-3xl flex-col gap-1 rounded-sm bg-background/90 px-4 py-3">
				<span className="font-semibold text-primary text-xs leading-4">
					{speaker}
				</span>
				{settled ? (
					<span className="line-clamp-3 text-[clamp(13px,1.9cqw,20px)] text-foreground leading-[1.45]">
						{text}
					</span>
				) : (
					<span className="flex flex-col text-[clamp(13px,1.9cqw,20px)] leading-[1.45]">
						{previous ? (
							<span className="truncate text-muted-foreground">{previous}</span>
						) : null}
						<span className="min-h-[1.45em] text-foreground">
							{shown}
							{typing ? (
								<span className="ml-0.5 inline-block h-[1em] w-[0.5ch] translate-y-[0.15em] bg-foreground/70 motion-safe:animate-pulse" />
							) : null}
						</span>
					</span>
				)}
			</div>
		</div>
	);
}

/**
 * The stream: a 16:9 frame of the agent at work, with the LIVE badge (or
 * Offline), and captions of the thread's newest message. Captions animate
 * only while live, with motion allowed, and not paused from the controls.
 */
export function LivePlayer({
	agent,
	live,
	maxWidth,
	reduceMotion,
	thread,
}: {
	agent: InterfaceAgent;
	live: boolean;
	/** Widest the frame may grow, so it fits the window's height. */
	maxWidth: number;
	reduceMotion: boolean;
	thread: InterfaceThread | null;
}) {
	const tl = useLiteralMessages();
	const [paused, setPaused] = useState(false);
	const spec = liveArt(thread, agent);
	const streaming = live && thread?.running === true;
	const animate = streaming && !paused && !reduceMotion;
	const message = thread?.lastMessage?.trim() ?? "";
	let label = tl("{name} is offline", { name: agent.name });
	if (thread) {
		label = streaming
			? tl("Live stream: {title}", { title: thread.title })
			: tl("Offline stream: {title}", { title: thread.title });
	}

	return (
		<figure
			aria-label={label}
			className="group/player relative m-0 flex w-full justify-center bg-muted"
			data-live-player={streaming ? "live" : "offline"}
		>
			<LiveScreen
				agent={agent}
				className="max-w-full"
				dim={!streaming}
				mode="player"
				spec={spec}
				style={{ maxWidth }}
			>
				<span className="absolute top-3 left-3 flex items-center gap-2">
					{streaming ? <LiveBadge /> : <LiveChip>Offline</LiveChip>}
				</span>
				{thread && message ? (
					<LiveCaptions
						animate={animate}
						key={thread.id}
						live={streaming}
						speaker={liveSpeaker(thread, agent)}
						text={message}
					/>
				) : null}
				{thread ? null : (
					<motion.span
						animate={{ opacity: 1 }}
						className="absolute inset-0 flex items-center justify-center"
						initial={reduceMotion ? false : { opacity: 0 }}
					>
						<span className="flex flex-col items-center gap-1 rounded-sm bg-background/90 px-6 py-4 text-center">
							<span className="font-semibold text-foreground text-sm leading-5">
								{tl("{name} is offline", { name: agent.name })}
							</span>
							<span className="text-muted-foreground text-sm leading-5">
								Send a message to start the first stream.
							</span>
						</span>
					</motion.span>
				)}
				{streaming && message ? (
					<span
						className={cn(
							"absolute bottom-3 left-3 flex opacity-0 transition-opacity group-focus-within/player:opacity-100 group-hover/player:opacity-100",
							paused && "opacity-100"
						)}
					>
						<Button
							aria-label={paused ? "Play captions" : "Pause captions"}
							aria-pressed={paused}
							className="bg-background/85 hover:bg-background"
							onClick={() => setPaused((value) => !value)}
							size="icon-sm"
							type="button"
							variant="ghost"
						>
							{paused ? (
								<Play aria-hidden="true" className="size-4" />
							) : (
								<Pause aria-hidden="true" className="size-4" />
							)}
						</Button>
					</span>
				) : null}
			</LiveScreen>
			{message && thread ? (
				<figcaption className="sr-only">
					{liveSpeaker(thread, agent)}: {message}
				</figcaption>
			) : null}
		</figure>
	);
}
