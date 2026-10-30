import { useConversationActivity } from "@ryu/blocks/desktop/agent-elements/conversation-activity.ts";
import { TextShimmer } from "@ryu/blocks/desktop/agent-elements/text-shimmer.tsx";
import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils.ts";
import {
	AnimatePresence,
	motion,
	type Transition,
	useReducedMotion,
} from "motion/react";
import { AgentAvatar, engineForAgent } from "@/src/lib/agent-logos.tsx";
import type { AgentSummary } from "@/src/lib/api/agents.ts";
import layout from "./chat-layout.module.css";

type BotChatHeaderAgent = Pick<
	AgentSummary,
	"avatarGlyph" | "avatarUrl" | "builtIn" | "engine" | "id" | "name" | "title"
>;

const FALLBACK_AGENT: BotChatHeaderAgent = {
	avatarGlyph: null,
	avatarUrl: null,
	builtIn: true,
	engine: "ryu",
	id: "ryu",
	name: "Ryu",
	title: "Bot",
};

const BUBBLE_SPRING: Transition = {
	type: "spring",
	stiffness: 520,
	damping: 38,
	mass: 0.8,
};

/**
 * The Bot-mode identity row above an active conversation. It intentionally
 * stays present for both a new chat and an existing thread so the managed
 * assistant remains the visual anchor while the transcript changes below it.
 *
 * The name bubble morphs taller while the bot is busy to show what it is doing
 * right now ("Thinking…", "Searching the web…"), read from the enclosing
 * AgentChat, and settles back to just the name when the turn ends.
 */
export function BotChatHeader({
	agent,
	clearTitleBar = true,
	className,
}: {
	agent?: BotChatHeaderAgent | null;
	/** Storyboards can disable this when they do not render the desktop title bar. */
	clearTitleBar?: boolean;
	className?: string;
}) {
	const currentAgent = agent ?? FALLBACK_AGENT;
	const name = currentAgent.name.trim() || FALLBACK_AGENT.name;
	const { label, state } = useConversationActivity();
	const reduceMotion = useReducedMotion();
	const tl = useLiteralMessages();
	const transition: Transition = reduceMotion ? { duration: 0 } : BUBBLE_SPRING;
	const busy =
		state === "thinking" || state === "working" || state === "responding";

	return (
		<header
			aria-label={tl("Chat with {name}", { name })}
			className={cn(
				"flex shrink-0 flex-col items-center gap-1.5 px-4 pb-1",
				clearTitleBar ? layout.titlebarInset : "pt-3",
				className
			)}
			data-testid="bot-chat-header"
		>
			<div
				aria-hidden="true"
				className="size-10"
				data-testid="bot-chat-header-avatar"
			>
				<AgentAvatar
					avatarUrl={currentAgent.avatarUrl}
					className="size-full object-contain"
					engine={engineForAgent(currentAgent)}
					glyph={currentAgent.avatarGlyph}
					size="40px"
				/>
			</div>
			{/* Reserves the expanded bubble's height so the transcript never jumps. */}
			<div className="flex h-12 items-start justify-center">
				<motion.div
					className="flex max-w-[18rem] flex-col items-center rounded-3xl bg-muted px-4 py-1.5 text-foreground"
					data-state={state}
					data-testid="bot-chat-header-name"
					layout
					transition={transition}
				>
					<motion.span
						className="truncate font-medium text-sm leading-5"
						layout="position"
						transition={transition}
					>
						{name}
					</motion.span>
					<AnimatePresence initial={false} mode="popLayout">
						{label ? (
							<motion.span
								animate={{ opacity: 1, y: 0 }}
								aria-live="polite"
								className={cn(
									"block max-w-full truncate text-xs leading-4",
									state === "error"
										? "text-status-destructive"
										: "text-muted-foreground"
								)}
								data-testid="bot-chat-header-status"
								exit={{ opacity: 0, y: -4 }}
								initial={{ opacity: 0, y: -4 }}
								key="status"
								layout="position"
								transition={transition}
							>
								{busy ? (
									<TextShimmer as="span" duration={1.6}>
										{label}
									</TextShimmer>
								) : (
									label
								)}
							</motion.span>
						) : null}
					</AnimatePresence>
				</motion.div>
			</div>
		</header>
	);
}
