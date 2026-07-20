"use client";

// Presentational layer of the desktop Council (multi-agent chat) + Teams
// surfaces. The live app drives these through `ChatPage` (council @mentions,
// attributed merged replies) and `TeamDialog` (coordination strategy); this
// block holds the purely-visual parts so the same JSX renders in the storyboard
// with mock data. One source of truth, so editing this block changes the real
// desktop too.
//
// Three exported pieces:
//  - `MentionList`     — the pure @mention candidate list. The real
//    `MentionAutocomplete` keeps its dismiss/escape effects + positioning ref
//    and renders this list (no hooks live here, matching the reference blocks).
//  - `CouncilView`     — the council chat surface: header + attributed message
//    stream (via the shared `MessageList`) + a composer slot.
//  - `TeamStrategyView`— a reconstruction of a team's coordination-strategy
//    panel, built from the strategy catalog (the real surface is the
//    `TeamDialog` modal; there is no full-page strategy screen).

import { Badge } from "@ryu/ui/components/badge";
import type { ChatStatus, UIMessage } from "ai";
import type { ReactNode } from "react";
import { MessageList } from "./agent-elements/message-list.tsx";

// ---------------------------------------------------------------------------
// MentionList — pure @mention candidate list (no hooks)
// ---------------------------------------------------------------------------

/** A single mention candidate — an agent or a team. Teams render with a group
 *  marker so the parent can resolve them to a team id. */
export interface MentionCandidate {
	id: string;
	isTeam: boolean;
	name: string;
}

export interface MentionListProps {
	/** Index of the keyboard-highlighted row, if any. */
	activeIndex?: number;
	/** Already-filtered, ordered candidates (teams first, then agents). */
	candidates: MentionCandidate[];
	/** Forwarded to the `<ul>` so the wrapper can attach its outside-click ref. */
	listRef?: React.Ref<HTMLUListElement>;
	/** Called with the candidate's name when a row is chosen. The real wrapper
	 *  passes this through `onMouseDown` + preventDefault to keep textarea focus. */
	onSelect?: (name: string) => void;
}

export function MentionList({
	candidates,
	activeIndex,
	onSelect,
	listRef,
}: MentionListProps) {
	if (candidates.length === 0) {
		return null;
	}

	return (
		<ul
			aria-label="Agent and team mentions"
			className="absolute bottom-full left-0 z-50 mb-1 max-h-48 w-56 overflow-y-auto rounded-lg border bg-popover p-1 shadow-lg"
			ref={listRef}
		>
			{candidates.map((item, i) => (
				<li
					aria-selected={i === activeIndex}
					key={`${item.isTeam ? "team" : "agent"}:${item.id}`}
				>
					<button
						className={`flex w-full items-center gap-1.5 rounded px-2 py-1.5 text-left text-sm hover:bg-muted ${
							i === activeIndex ? "bg-accent" : ""
						}`}
						onMouseDown={(e) => {
							// Prevent the textarea from losing focus.
							e.preventDefault();
							onSelect?.(item.name);
						}}
						type="button"
					>
						<span className="font-medium text-primary">@</span>
						<span className="min-w-0 flex-1 truncate">{item.name}</span>
						{item.isTeam ? (
							<span className="shrink-0 rounded bg-muted px-1 text-[10px] text-muted-foreground">
								team
							</span>
						) : null}
					</button>
				</li>
			))}
		</ul>
	);
}

// ---------------------------------------------------------------------------
// CouncilView — council chat surface (header + attributed stream + composer)
// ---------------------------------------------------------------------------

export interface CouncilViewProps {
	/** The composer, injected as a slot (the real council composer is the
	 *  interactive `CouncilInputBar`; the storyboard passes a static stand-in). */
	composer?: ReactNode;
	/** Attributed conversation messages. Council replies carry a
	 *  `**Name**\n\n…` text prefix, which `MessageList` renders as the member
	 *  heading — exactly how the real `ChatPage` attributes council turns. */
	messages: UIMessage[];
	/** The participating agents/teams, summarised in the header. */
	participantSummary: string;
	status: ChatStatus;
	/** Optional right-aligned status pill, e.g. "broadcast · 2 / 3 replied". */
	statusBadge?: string | null;
}

export function CouncilView({
	participantSummary,
	messages,
	status,
	statusBadge,
	composer,
}: CouncilViewProps) {
	return (
		<div className="flex h-full min-h-0 flex-col">
			<header className="flex items-center gap-2 border-border border-b px-4 py-2.5">
				<Badge variant="outline">Council</Badge>
				<span className="text-muted-foreground text-sm">
					{participantSummary}
				</span>
				{statusBadge ? (
					<Badge className="ml-auto" variant="secondary">
						{statusBadge}
					</Badge>
				) : null}
			</header>
			<MessageList messages={messages} status={status} />
			{composer}
		</div>
	);
}

// ---------------------------------------------------------------------------
// TeamStrategyView — reconstruction of a team's coordination panel
// ---------------------------------------------------------------------------

export interface CoordinationStrategy {
	description: string;
	label: string;
	value: string;
}

export interface TeamStrategyViewProps {
	/** The currently-selected strategy value. */
	activeStrategy: string;
	memberNames: string[];
	strategies: CoordinationStrategy[];
	teamName: string;
}

// ---------------------------------------------------------------------------
// CouncilPreview — variant-driven preview that builds the attributed message
// stream internally, so `ai`-typed mocks stay inside the block (the storyboard
// tree has no `ai` dependency). Mirrors how `DesktopChatPreview` keeps `ai`
// construction out of the storyboard screen.
// ---------------------------------------------------------------------------

const councilText = (
	id: string,
	role: "user" | "assistant",
	text: string
): UIMessage =>
	({
		id,
		role,
		parts: [{ type: "text", text }],
	}) as unknown as UIMessage;

const COUNCIL_USER_PROMPT =
	"What is the best on-device model for coding right now?";

// Council attribution: the real `ChatPage` prefixes each member's reply with a
// `**Name**\n\n…` markdown heading, which `MessageList` renders as the member
// label. These mocks reproduce that exact shape.
const COUNCIL_RESEARCHER =
	"**Researcher**\n\nQwen3-Coder-30B leads open coding benchmarks; the Q4_K_M GGUF needs about 18 GB and partial GPU offload.";

const COUNCIL_CRITIC =
	"**Critic**\n\nWatch context length: a 30B at Q4 can struggle past 32K tokens on consumer GPUs. Gemma 4 12B is a safer default.";

const COUNCIL_WRITER =
	"**Writer**\n\nRecommendation: start with Gemma 4 12B for everyday work, keep Qwen3-Coder installed for heavy refactors.";

export function CouncilPreview({
	streaming,
	composer,
}: {
	/** When true, the final member is still replying (2 / 3 answered). */
	streaming?: boolean;
	composer?: ReactNode;
}) {
	const messages: UIMessage[] = streaming
		? [
				councilText("u1", "user", COUNCIL_USER_PROMPT),
				councilText("a1", "assistant", COUNCIL_RESEARCHER),
				councilText("a2", "assistant", COUNCIL_CRITIC),
			]
		: [
				councilText("u1", "user", COUNCIL_USER_PROMPT),
				councilText("a1", "assistant", COUNCIL_RESEARCHER),
				councilText("a2", "assistant", COUNCIL_CRITIC),
				councilText("a3", "assistant", COUNCIL_WRITER),
			];

	return (
		<CouncilView
			composer={composer}
			messages={messages}
			participantSummary="Researcher, Critic, Writer"
			status={streaming ? "streaming" : "ready"}
			statusBadge={streaming ? "broadcast · 2 / 3 replied" : null}
		/>
	);
}

export function TeamStrategyView({
	teamName,
	memberNames,
	strategies,
	activeStrategy,
}: TeamStrategyViewProps) {
	return (
		<div className="flex h-full min-h-0 flex-col">
			<header className="flex items-center gap-2 border-border border-b px-4 py-3">
				<h2 className="font-semibold">{teamName}</h2>
				<Badge variant="outline">{memberNames.length} members</Badge>
			</header>
			<div className="mx-auto w-full max-w-xl space-y-6 p-6">
				<section className="space-y-2">
					<h3 className="font-medium text-sm">Coordination strategy</h3>
					<div className="space-y-2">
						{strategies.map((s) => {
							const active = s.value === activeStrategy;
							return (
								<div
									className={`flex items-start gap-3 rounded-lg border p-3 ${
										active ? "border-primary bg-primary/5" : "border-border"
									}`}
									key={s.value}
								>
									<span
										className={`mt-0.5 size-4 rounded-full border ${
											active
												? "border-primary bg-primary"
												: "border-muted-foreground/40"
										}`}
									/>
									<div>
										<p className="font-medium text-sm">{s.label}</p>
										<p className="text-muted-foreground text-xs">
											{s.description}
										</p>
									</div>
								</div>
							);
						})}
					</div>
				</section>
				<section className="space-y-2">
					<h3 className="font-medium text-sm">Members</h3>
					<div className="flex flex-wrap gap-2">
						{memberNames.map((m) => (
							<Badge key={m} variant="secondary">
								{m}
							</Badge>
						))}
					</div>
					<p className="text-muted-foreground text-xs">
						Drag an agent row from the sidebar onto a team to add a member.
					</p>
				</section>
			</div>
		</div>
	);
}
