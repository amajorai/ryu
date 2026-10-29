import { cn } from "@ryu/ui/lib/utils";
import type {
	InterfaceAgent,
	InterfacePort,
	InterfaceThread,
} from "@ryuhq/protocol/interfaces";
import {
	type ComponentProps,
	type CSSProperties,
	type KeyboardEvent,
	type ReactNode,
	useId,
	useState,
} from "react";
import { compactAge } from "./interface-renderer.ts";
import { frameStyle, SV_PLANK_TEXT, SV_TEXT } from "./world-2d-frame.ts";
import { PixelKey } from "./world-2d-hud.tsx";
import { PixelPortrait } from "./world-2d-portrait.tsx";
import type { WorldPalette } from "./world-themes.ts";

const MAX_PROMPT_LENGTH = 8000;

/**
 * The talk panel, drawn as a Stardew Valley dialogue box: wooden frames with
 * parchment insides, the villager's framed portrait with a name plate under
 * it, their line in the box, past conversations as dialogue choices, and a
 * reply box. When a thread is open the host's real chat sits in a parchment
 * well inside the same frame.
 */

const UI_FONT = "font-bold font-sans";

/** A small wooden plank button that presses down. */
const PLANK_BUTTON = cn(
	"inline-flex items-center gap-1.5 text-[13px] leading-none outline-none transition-transform hover:brightness-110 focus-visible:outline-3 focus-visible:outline-[#ffd25e] focus-visible:outline-offset-1 active:translate-y-[2px]",
	UI_FONT
);

/** Wooden backing behind the frames: horizontal planks on the pixel grid. */
const PANEL_BACKING = {
	backgroundColor: "#6b3a1c",
	backgroundImage:
		"repeating-linear-gradient(180deg, #7a4421 0 21px, #5b2f15 21px 24px), repeating-linear-gradient(90deg, transparent 0 117px, #4e2711 117px 120px)",
} as const;

/**
 * The host's design tokens, re-pointed at the dialogue box's parchment and
 * wood, so the real chat inside the panel (still the host's component)
 * reads as part of the dialogue box: parchment page, brown ink, wood-orange
 * accents, tan rules.
 */
const PARCHMENT_TOKENS: CSSProperties & Record<`--${string}`, string> = {
	"--accent": "#f7d798",
	"--accent-foreground": "#3d1f0d",
	"--background": "#fbe9c4",
	"--border": "#d9a25a",
	"--card": "#fff3d6",
	"--card-foreground": "#3d1f0d",
	"--foreground": "#3d1f0d",
	"--input": "#d9a25a",
	"--muted": "#f3d49a",
	"--muted-foreground": "#7a4a24",
	"--popover": "#fff3d6",
	"--popover-foreground": "#3d1f0d",
	"--primary": "#b5651d",
	"--primary-foreground": "#fff4d6",
	"--ring": "#5b2a0b",
	"--secondary": "#f3d49a",
	"--secondary-foreground": "#3d1f0d",
	colorScheme: "light",
};

/** Stardew's red close "X", as pixels. */
function CloseIcon() {
	return (
		<svg
			aria-hidden="true"
			height="14"
			shapeRendering="crispEdges"
			viewBox="0 0 7 7"
			width="14"
		>
			<path
				d="M0 0h2v1h1v1h1v-1h1v-1h2v2h-1v1h-1v1h1v1h1v2h-2v-1h-1v-1h-1v1h-1v1h-2v-2h1v-1h1v-1h-1v-1h-1z"
				fill="#7a1410"
			/>
			<path
				d="M1 1h1v1h1v1h1v-1h1v-1h1v1h-1v1h-1v1h1v1h1v1h-1v-1h-1v-1h-1v1h-1v1h-1v-1h1v-1h1v-1h-1v-1h-1z"
				fill="#e2453a"
			/>
		</svg>
	);
}

/**
 * Beside each dialogue choice: a small tan diamond, swapped for the
 * pointing glove Stardew shows beside the hovered or focused choice.
 */
function ChoicePointer() {
	return (
		<span aria-hidden="true" className="flex w-[18px] shrink-0 justify-center">
			<svg
				className="group-hover:hidden group-focus-visible:hidden"
				height="8"
				shapeRendering="crispEdges"
				viewBox="0 0 4 4"
				width="8"
			>
				<path d="M1 0h2v1h1v2h-1v1h-2v-1h-1v-2h1z" fill="#c99a5a" />
				<path d="M1 1h1v1h-1z" fill="#f7d798" />
			</svg>
			<ChoiceGlove />
		</span>
	);
}

/** The pointing glove. */
function ChoiceGlove() {
	return (
		<svg
			className="hidden group-hover:block group-focus-visible:block"
			height="14"
			shapeRendering="crispEdges"
			viewBox="0 0 9 7"
			width="18"
		>
			<path
				d="M0 1h5v-1h2v1h1v1h1v3h-1v1h-1v1h-5v-1h-1v-1h-1z"
				fill="#5b2a0b"
			/>
			<path d="M1 2h5v-1h1v1h1v3h-1v1h-4v-1h-2z" fill="#fff4d6" />
			<path d="M3 4h4v1h-4z" fill="#e2b36e" />
		</svg>
	);
}

/** Animated Stardew "..." for a villager who is busy. */
function WorkingDots() {
	return (
		<span aria-hidden="true" className="inline-flex items-end gap-[3px]">
			{[0, 1, 2].map((dot) => (
				<span
					className="size-[4px] bg-[#3d1f0d] motion-safe:animate-pulse"
					key={dot}
					style={{ animationDelay: `${dot * 0.25}s` }}
				/>
			))}
		</span>
	);
}

/** The villager's framed portrait with the name plate under it. */
function PortraitCard({
	agent,
	lookIndex,
	small,
}: {
	agent: InterfaceAgent;
	lookIndex: number;
	small: boolean;
}) {
	return (
		<div className="flex shrink-0 flex-col items-center gap-1.5">
			<div
				className="flex items-end justify-center overflow-hidden"
				style={frameStyle("slot", 2)}
			>
				{/* A narrow panel (or an open thread) gets the 2x bust. */}
				<PixelPortrait
					agentId={agent.id}
					className={cn("-mb-[4px]", small ? null : "@sm:hidden")}
					crop="bust"
					lookIndex={lookIndex}
					scale={2}
					working={agent.status === "working"}
				/>
				{small ? null : (
					<PixelPortrait
						agentId={agent.id}
						className="-mb-[4px] @sm:block hidden"
						crop="bust"
						lookIndex={lookIndex}
						scale={3}
						working={agent.status === "working"}
					/>
				)}
			</div>
			<p
				className={cn(
					"max-w-[120px] truncate text-center text-[13px] leading-none",
					UI_FONT
				)}
				style={{ ...frameStyle("plank", 2), ...SV_PLANK_TEXT }}
			>
				{agent.name}
			</p>
		</div>
	);
}

const GREETINGS = [
	"What do you need?",
	"What are we working on today?",
	"Got something for me?",
	"Good to see you. What's up?",
] as const;

/** What the villager says when you walk up: a line in their own voice. */
function villagerLine(
	agent: InterfaceAgent,
	threads: readonly InterfaceThread[],
	brief: boolean
): string {
	if (agent.status === "working") {
		const busy = threads.find((thread) => thread.running);
		const line = busy?.title
			? `Hang on, I'm deep in “${busy.title}”.`
			: "Hang on, I'm in the middle of something.";
		return brief ? line : `${line} Leave me a note and I'll get to it.`;
	}
	let hash = 0;
	for (const char of agent.id) {
		hash = (hash * 31 + (char.codePointAt(0) ?? 0)) % 997;
	}
	const greeting = GREETINGS[hash % GREETINGS.length] ?? GREETINGS[0];
	return threads.length > 0
		? `Hey, it's ${agent.name} again! ${greeting}`
		: `Hey! I'm ${agent.name}. First time stopping by? ${greeting}`;
}

/** The dialogue box: the villager's line beside the portrait. */
function DialogueBox({
	agent,
	compact,
	lookIndex,
	threads,
}: {
	agent: InterfaceAgent;
	compact: boolean;
	lookIndex: number;
	threads: readonly InterfaceThread[];
}) {
	const working = agent.status === "working";
	return (
		<section
			aria-label={`${agent.name} says`}
			className="flex shrink-0 items-start gap-3 p-1.5"
			style={{ ...frameStyle("wood"), ...SV_TEXT }}
		>
			<div className="flex min-w-0 flex-1 flex-col gap-2 self-stretch pt-0.5">
				<p
					className={cn(
						"font-sans font-semibold text-[17px] leading-snug",
						compact && "line-clamp-2"
					)}
				>
					{villagerLine(agent, threads, compact)}
				</p>
				{agent.description ? (
					<p
						className={cn(
							"font-sans font-semibold text-[#7a4a24] text-[12px] leading-tight",
							compact && "line-clamp-1"
						)}
					>
						<span className="sr-only">Role: </span>
						{agent.description}
					</p>
				) : null}
				<p
					className={cn(
						"mt-auto flex flex-wrap items-center gap-x-2 gap-y-1 border-[#e2b36e] border-t-2 border-dashed pt-2 text-[12px] leading-none",
						UI_FONT
					)}
				>
					{working ? (
						<>
							<WorkingDots />
							<span>Working</span>
						</>
					) : (
						<span className="text-[#5b7a2a]">Idle · ready to talk</span>
					)}
					<span aria-hidden="true" className="text-[#c99a5a]">
						·
					</span>
					<span className="text-[#7a4a24]">
						{threads.length > 0
							? `${threads.length} past ${threads.length === 1 ? "chat" : "chats"}`
							: "First visit"}
					</span>
				</p>
			</div>
			<PortraitCard agent={agent} lookIndex={lookIndex} small={compact} />
		</section>
	);
}

/** The reply box the player types into to start a conversation. */
function ReplyBox({
	agent,
	onSubmit,
}: {
	agent: InterfaceAgent;
	onSubmit: (prompt: string) => void;
}) {
	const fieldId = useId();
	const hintId = useId();
	const [prompt, setPrompt] = useState("");
	const trimmed = prompt.trim();

	const submit = () => {
		if (!trimmed) {
			return;
		}
		onSubmit(trimmed);
		setPrompt("");
	};
	const onFormSubmit: ComponentProps<"form">["onSubmit"] = (event) => {
		event.preventDefault();
		submit();
	};
	const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		if (
			event.key === "Enter" &&
			!event.shiftKey &&
			!event.nativeEvent.isComposing
		) {
			event.preventDefault();
			submit();
		}
	};

	return (
		<form
			className="flex shrink-0 flex-col gap-2 p-1.5"
			onSubmit={onFormSubmit}
			style={{ ...frameStyle("wood"), ...SV_TEXT }}
		>
			<label
				className={cn("text-[13px] leading-none", UI_FONT)}
				htmlFor={fieldId}
			>
				<span className="sr-only">Say something to {agent.name}</span>
				<span aria-hidden="true">Your reply</span>
			</label>
			<textarea
				aria-describedby={hintId}
				className="min-h-[68px] resize-none border-2 border-[#c99a5a] bg-[#fff3cf] px-2.5 py-2 font-sans font-semibold text-[#3d1f0d] text-[15px] leading-snug shadow-[inset_2px_2px_0_#e9c98d] outline-none placeholder:text-[#a87c4c] focus-visible:border-[#5b2a0b]"
				id={fieldId}
				maxLength={MAX_PROMPT_LENGTH}
				onChange={(event) => setPrompt(event.target.value)}
				onKeyDown={onKeyDown}
				placeholder={`Say something to ${agent.name}…`}
				value={prompt}
			/>
			<div className="flex items-center justify-between gap-2">
				<p
					className="font-sans font-semibold text-[#7a4a24] text-[11px] leading-tight"
					id={hintId}
				>
					Enter to say it · Shift+Enter for a new line
				</p>
				<button
					className={cn(
						PLANK_BUTTON,
						"disabled:pointer-events-none disabled:opacity-50"
					)}
					disabled={!trimmed}
					style={{ ...frameStyle("plank", 2), ...SV_PLANK_TEXT }}
					type="submit"
				>
					Say it
				</button>
			</div>
		</form>
	);
}

/** Past conversations as Stardew dialogue choices. */
function DialogueChoices({
	onOpen,
	threads,
}: {
	onOpen: (threadId: string) => void;
	threads: InterfaceThread[];
}) {
	const headingId = useId();
	return (
		<section
			aria-labelledby={headingId}
			className="flex min-h-[6.5rem] shrink flex-col gap-1.5 px-1.5 pb-1"
			style={{ ...frameStyle("wood"), ...SV_TEXT }}
		>
			<h3
				className={cn(
					"-mt-[22px] self-start px-1 text-[12px] uppercase leading-none tracking-[0.06em]",
					UI_FONT
				)}
				id={headingId}
				style={{ ...frameStyle("plank", 2), ...SV_PLANK_TEXT }}
			>
				Past conversations
			</h3>
			{threads.length === 0 ? (
				<p className="font-sans font-semibold text-[#7a4a24] text-[14px] leading-snug">
					Nothing yet. Say something below to start your first conversation.
				</p>
			) : null}
			<ul className="-mx-1 flex max-h-[13.5rem] min-h-0 flex-col overflow-y-auto px-1 [scrollbar-color:#c99a5a_transparent] [scrollbar-width:thin]">
				{threads.map((thread) => (
					<li key={thread.id}>
						<button
							className="group flex w-full items-center gap-2 border-2 border-transparent py-1.5 pr-1.5 pl-0.5 text-left font-sans font-semibold text-[15px] leading-tight outline-none hover:border-[#d9a25a] hover:bg-[#ecc681] focus-visible:border-[#5b2a0b] focus-visible:bg-[#ecc681]"
							onClick={() => onOpen(thread.id)}
							type="button"
						>
							<ChoicePointer />
							<span className="min-w-0 flex-1 truncate">
								{thread.title || "Untitled"}
							</span>
							{thread.running ? (
								<span
									className={cn(
										"inline-flex shrink-0 items-center gap-1.5 text-[#2f6b1f] text-[11px]",
										UI_FONT
									)}
								>
									<span
										aria-hidden="true"
										className="size-[6px] bg-[#4f9534] motion-safe:animate-pulse"
									/>
									Working
								</span>
							) : null}
							<span className="shrink-0 text-[#7a4a24] text-[12px] tabular-nums">
								{compactAge(thread.updatedAt)}
							</span>
						</button>
					</li>
				))}
			</ul>
		</section>
	);
}

/**
 * The conversation panel a world opens when the player talks to an agent.
 * `palette` is accepted for callers that theme their worlds; the dialogue
 * box keeps Stardew's wood and parchment in every theme.
 */
export function WorldAgentPanel({
	agent,
	lookIndex = -1,
	onClose,
	port,
	threads,
	threadView,
}: {
	agent: InterfaceAgent;
	/** The agent's place in the village (picks its portrait's outfit). */
	lookIndex?: number;
	onClose: () => void;
	palette?: WorldPalette;
	port: InterfacePort;
	threads: InterfaceThread[];
	threadView: ReactNode | null;
}) {
	return (
		<aside
			aria-label={`Talking to ${agent.name}`}
			className="@container flex h-full w-[clamp(320px,40%,440px)] shrink-0 flex-col gap-2 overflow-y-auto overflow-x-hidden border-[#3f1c08] border-l-[3px] p-2.5 shadow-[-4px_0_0_rgba(63,28,8,0.35)] [scrollbar-color:#c99a5a_transparent] [scrollbar-width:thin]"
			data-testid="world-agent-panel"
			style={PANEL_BACKING}
		>
			<div className="flex shrink-0 items-center justify-end gap-2">
				{threadView ? (
					<button
						className={cn(PLANK_BUTTON, "mr-auto")}
						onClick={port.closeThread}
						style={{ ...frameStyle("plank", 2), ...SV_PLANK_TEXT }}
						type="button"
					>
						<span aria-hidden="true">◀</span>
						Back to conversations
					</button>
				) : null}
				<button
					aria-label="Walk away"
					className={PLANK_BUTTON}
					onClick={onClose}
					style={{ ...frameStyle("plank", 2), ...SV_PLANK_TEXT }}
					type="button"
				>
					<PixelKey
						aria-hidden="true"
						className="h-[18px] min-w-[18px] px-0.5 text-[10px]"
					>
						Esc
					</PixelKey>
					Walk away
					<CloseIcon />
				</button>
			</div>
			<DialogueBox
				agent={agent}
				compact={threadView !== null}
				lookIndex={lookIndex}
				threads={threads}
			/>
			{threadView ? (
				<div
					className="flex min-h-0 flex-1 flex-col"
					style={frameStyle("wood")}
				>
					<div
						className="-m-1 min-h-0 flex-1 overflow-hidden border-2 border-[#c99a5a] bg-background font-medium text-foreground shadow-[inset_2px_2px_0_#e9c98d]"
						style={PARCHMENT_TOKENS}
					>
						{threadView}
					</div>
				</div>
			) : (
				<div className="flex min-h-0 flex-1 flex-col gap-2 pt-3">
					<DialogueChoices onOpen={port.openThread} threads={threads} />
					<ReplyBox
						agent={agent}
						key={agent.id}
						onSubmit={(prompt) =>
							port.startThread({ agentId: agent.id, prompt })
						}
					/>
				</div>
			)}
		</aside>
	);
}
