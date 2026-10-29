"use client";
import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import type { CSSProperties } from "react";
import styles from "./hero-workflow-loop.module.css";

/*
 * The landing hero's visualisation: a looping, scripted run of ONE real Ryu
 * workflow across BOTH surfaces, so the two-surface story is shown instead of
 * asserted.
 *
 *   Island (always on top, glanceable)  →  Desktop app (where the work runs)
 *
 * The stage reads as a real desktop: the hero's background image is the
 * wallpaper, the scaled window is the app, and the island floats OUTSIDE that
 * window — centred on the wallpaper above it — because that is where an
 * always-on-top pill actually lives. The phase strip and the surface legend sit
 * BELOW the window so the top of the frame is the island's alone.
 *
 * The beat list is the whole script: every visual — island state, cursor,
 * transcript contents, caption, phase chip — is DERIVED from the current beat
 * index, so the loop restarting is just `index = 0` and there is no accumulated
 * state to drift. Beats advance on a timer that only runs while the stage is on
 * screen; `prefers-reduced-motion` freezes it on the finished beat instead.
 *
 * Like the showcase it replaces, this is NOT a redrawn approximation: it composes
 * the same real `DesktopShell` + `AgentChat` the app ships, and the island is the
 * real island shape vocabulary from `island-shapes.tsx`. The transcript is fed
 * real AI-SDK v5 tool parts, so the tool rows are the app's own renderers.
 *
 * The persistent site island (`GlobalIsland`) is suppressed while this stage is
 * visible — one island on screen at a time.
 */

import { Button } from "@ryu/ui/components/button";
import { Logo as RyuLogo } from "@ryu/ui/components/logo";
import { Tabs, TabsList, TabsTrigger } from "@ryu/ui/components/tabs";
import { cn } from "@ryu/ui/lib/utils";
import type { ChatStatus, DynamicToolUIPart, TextUIPart, UIMessage } from "ai";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AgentChat } from "../desktop/agent-elements/agent-chat.tsx";
import { DesktopShell } from "../desktop/shell.tsx";
import { IslandSuggestionChip } from "../island/suggestion-chip.tsx";
import {
	ACTION_PILL_HEIGHT,
	ACTION_PILL_WIDTH,
	CONTENT_SPRING,
	DETAIL_SIZES,
	ISLAND_SPRING,
	ISLAND_SURFACE_BASE,
	type IslandAction,
	IslandActionPills,
	LOGO_CIRCLE,
	SPLIT_GAP,
	SUGGESTION_STACK_GAP,
	TRANSLUCENT_SKIN,
} from "./island-shapes.tsx";
import { type IslandState, setIslandSuppressed } from "./island-store.ts";

/* ── the transcript the desktop half plays back ────────────────────────────── */

const textMessage = (
	id: string,
	role: "user" | "assistant",
	text: string
): UIMessage => ({ id, role, parts: [{ type: "text", text }] });

/** Authored pre-run tool cells; assistantParts supplies the actual SDK state. */
interface ScriptedToolPart {
	input: DynamicToolUIPart["input"];
	output: DynamicToolUIPart["output"];
	toolCallId: string;
	type: `tool-${string}`;
}
type Part = TextUIPart | ScriptedToolPart;

/** Both variants are owned by this script: text or a prefixed tool name. */
function isScriptedToolPart(part: Part): part is ScriptedToolPart {
	return isNativeText(part.type) && part.type.startsWith("tool");
}

const toolPart = (
	name: string,
	input: DynamicToolUIPart["input"],
	output: DynamicToolUIPart["output"]
): ScriptedToolPart => ({
	type: `tool-${name}`,
	toolCallId: `hero-${name}`,
	input,
	output,
});

/* ── the use cases the loop rotates through ────────────────────────────────── */

/**
 * One scripted job. Every scenario has the SAME shape — an idle exchange, a
 * prompt, an opening line, exactly FOUR tool calls and a closing line — because
 * the beat list is built from that shape and the beat indices (`accept`,
 * `handoff`, `done`) are referenced by the island's real buttons. Four steps is
 * also the honest number: it is what fits on screen without the transcript
 * scrolling itself mid-demo.
 *
 * They are deliberately ordinary jobs — the inbox, the weekly update, receipts,
 * a calendar clash — because the point being made is "this is your Tuesday",
 * not "this is a demo".
 */
interface Step {
	caption: string;
	part: Part;
}

interface Scenario {
	/** The closing assistant line, after the last tool resolves. */
	close: string;
	id: string;
	/** The exchange already on screen before the island interrupts. */
	idle: { answer: string; question: string };
	/** The first assistant line, before any tool runs. */
	intro: string;
	/** Chip text in the use-case switcher. */
	label: string;
	/** The caption on the beat where the island offers the job. */
	noticeCaption: string;
	prompt: string;
	/** The Space shown in the app's top bar. */
	space: string;
	steps: [Step, Step, Step, Step];
	suggestion: { body: string; title: string };
}

const SCENARIOS: [Scenario, ...Scenario[]] = [
	{
		id: "call",
		label: "After a call",
		space: "Meetings",
		idle: {
			question: "What's left on my plate this afternoon?",
			answer:
				"Two things: the Acme call at 3, and the Q3 report draft. I'll watch the call and pick up anything that turns into work.",
		},
		suggestion: {
			title: "Your Acme call just ended",
			body: "Draft the follow-up and log the deal?",
		},
		noticeCaption:
			"Your 3pm ends. The Island already knows what happened and offers the next step — nothing to open, nothing to prompt.",
		prompt:
			"Draft the Acme follow-up, log it against the deal, and post the summary to #sales.",
		intro:
			"On it. Reading today's Acme transcript from your Meetings space — that stays on this machine.",
		steps: [
			{
				caption:
					"Step 1 — it reads the call transcript straight off your machine.",
				part: toolPart(
					"Read",
					{ file_path: "~/Ryu/Spaces/Meetings/acme-call.md" },
					{
						preview: "42 min transcript · 3 action items · decision due Friday",
					}
				),
			},
			{
				caption:
					"Step 2 — it drafts the follow-up in Gmail, using the connector you already granted.",
				part: toolPart(
					"mcp.gmail.create_draft",
					{ to: "sarah@acme.com", subject: "Acme — follow-up and next steps" },
					{ id: "draft_8241", status: "draft saved" }
				),
			},
			{
				caption: "Step 3 — it logs the outcome against the deal in your CRM.",
				part: toolPart(
					"mcp.hubspot.create_note",
					{
						deal: "Acme — pilot",
						body: "3 action items agreed, decision due Friday.",
					},
					{ id: "note_5512" }
				),
			},
			{
				caption: "Step 4 — it posts the summary where your team will see it.",
				part: toolPart(
					"mcp.slack.send_message",
					{
						channel: "#sales",
						text: "Acme pilot: follow-up drafted, decision due Friday.",
					},
					{ ok: true }
				),
			},
		],
		close:
			"Done. The draft is waiting in your inbox, the deal has the notes, and #sales is posted. Four tools, one accept — and the transcript itself stayed on your machine; only the summary you approved went out.",
	},
	{
		id: "inbox",
		label: "Inbox triage",
		space: "Inbox",
		idle: {
			question: "Anything in my inbox that actually needs me?",
			answer:
				"84 unread since last night, and most of it is noise. Say the word and I'll sort it before your first meeting.",
		},
		suggestion: {
			title: "84 unread since last night",
			body: "Triage the inbox before your 9am?",
		},
		noticeCaption:
			"You open your laptop to 84 unread. The Island has already looked, and offers to deal with it.",
		prompt:
			"Triage this morning's inbox: draft the easy replies, flag what needs me, archive the rest.",
		intro:
			"Reading the inbox now. Nothing gets sent — you'll approve every reply that leaves.",
		steps: [
			{
				caption:
					"Step 1 — it reads the mail you already gave it access to, and sorts the noise from the six that matter.",
				part: toolPart(
					"mcp.gmail.list_messages",
					{ query: "is:unread newer_than:1d" },
					{ unread: 84, needs_reply: 6, newsletters: 71 }
				),
			},
			{
				caption:
					"Step 2 — the easy ones come back as drafts, not sent mail. You still hit send.",
				part: toolPart(
					"mcp.gmail.create_draft",
					{
						to: "priya@northwind.com",
						subject: "Re: Thursday deadline — confirmed",
					},
					{ drafts: 6, status: "6 drafts saved" }
				),
			},
			{
				caption:
					"Step 3 — the ones that genuinely need you get flagged, at the top.",
				part: toolPart(
					"mcp.gmail.add_label",
					{ label: "Needs you", count: 6 },
					{ ok: true }
				),
			},
			{
				caption:
					"Step 4 — the other 71 are archived, so the inbox you open is the inbox that matters.",
				part: toolPart(
					"mcp.gmail.update_messages",
					{ action: "archive", count: 71 },
					{ archived: 71 }
				),
			},
		],
		close:
			"Done. Six drafts waiting on your send, six flagged, 71 archived. Your inbox is a six-item list — and nothing went out without you.",
	},
	{
		id: "update",
		label: "Weekly update",
		space: "Work",
		idle: {
			question: "What did I actually get done this week?",
			answer:
				"More than it feels like. It's all in your commits, tickets and calendar — I can write the update whenever you want it.",
		},
		suggestion: {
			title: "It's Friday — your update isn't written",
			body: "Draft it from this week's work?",
		},
		noticeCaption:
			"Friday afternoon. The Island notices the update you write every week is still not written.",
		prompt:
			"Write my weekly update from this week's work and post it in #standup.",
		intro:
			"Pulling the week together — commits, tickets and the meetings that changed something.",
		steps: [
			{
				caption:
					"Step 1 — it reads the week you actually had, instead of asking you to remember it.",
				part: toolPart(
					"mcp.github.list_commits",
					{ author: "me", since: "Monday" },
					{ commits: 37, repos: 3 }
				),
			},
			{
				caption: "Step 2 — it checks what closed and what is still in flight.",
				part: toolPart(
					"mcp.linear.list_issues",
					{ assignee: "me", state: "done, in progress" },
					{ done: 9, in_progress: 2, blocked: 1 }
				),
			},
			{
				caption:
					"Step 3 — the update is written where your team already keeps them.",
				part: toolPart(
					"mcp.notion.create_page",
					{ title: "Weekly update — week 32", parent: "Team updates" },
					{ id: "page_2291", status: "published" }
				),
			},
			{
				caption:
					"Step 4 — and posted in your voice, without you re-typing your own week.",
				part: toolPart(
					"mcp.slack.send_message",
					{
						channel: "#standup",
						text: "Shipped 9, 2 in flight, blocked on the billing API key.",
					},
					{ ok: true }
				),
			},
		],
		close:
			"Done. Nine shipped, two in flight, one blocker named. Written from what you did, not from what you could remember on a Friday.",
	},
	{
		id: "expenses",
		label: "Expenses",
		space: "Admin",
		idle: {
			question: "Remind me what I'm behind on.",
			answer:
				"Expenses. Fourteen receipts from last month's trip are still sitting in your Downloads folder.",
		},
		suggestion: {
			title: "14 receipts still sitting in Downloads",
			body: "Turn them into last month's expense report?",
		},
		noticeCaption:
			"The admin you keep postponing. The Island brings it up once, at a moment you can actually deal with it.",
		prompt:
			"Sort last month's receipts, total them up, and get the expense report ready to submit.",
		intro:
			"Starting with the receipts on disk. The PDFs are read locally and never uploaded.",
		steps: [
			{
				caption:
					"Step 1 — it finds the receipts where they actually are: your Downloads folder.",
				// `numFiles` is the key the Glob row's title reads — anything else
				// renders as "No files found".
				part: toolPart(
					"Glob",
					{ pattern: "~/Downloads/*receipt*.pdf" },
					{ numFiles: 14 }
				),
			},
			{
				caption:
					"Step 2 — it reads the selected files. Check the configured model and tool destinations before sharing bank details.",
				part: toolPart(
					"Read",
					{ file_path: "~/Downloads/hotel-receipt-14-mar.pdf" },
					{ preview: "Hotel · 14 Mar · $412.80 · card ending 4471" }
				),
			},
			{
				caption: "Step 3 — the sheet gets filled in, categorised and totalled.",
				part: toolPart(
					"mcp.sheets.update_rows",
					{ sheet: "Expenses — March", rows: 14 },
					{ total: "$1,284.40" }
				),
			},
			{
				caption: "Step 4 — the submission email is drafted and waiting on you.",
				part: toolPart(
					"mcp.gmail.create_draft",
					{
						to: "finance@yourcompany.com",
						subject: "March expenses — $1,284.40 (14 receipts)",
					},
					{ id: "draft_9930", status: "draft saved" }
				),
			},
		],
		close:
			"Done. Fourteen receipts, $1,284.40, sorted into March. Nothing was submitted — the email is drafted and it's your send.",
	},
	{
		id: "calendar",
		label: "Calendar clash",
		space: "Calendar",
		idle: {
			question: "Is Thursday still fine?",
			answer:
				"Not quite. Your dentist appointment now sits on top of the design review — I can move things around if you want.",
		},
		suggestion: {
			title: "Thursday has a clash",
			body: "Move the design review and tell the team?",
		},
		noticeCaption:
			"A clash you hadn't spotted yet. The Island raises it before it becomes an apology.",
		prompt: "Move the design review off my dentist slot and tell everyone.",
		intro:
			"Looking at Thursday. I'll find a slot that works for all five of you before I move anything.",
		steps: [
			{
				caption:
					"Step 1 — it reads the day and finds the clash you hadn't noticed.",
				part: toolPart(
					"mcp.gcal.list_events",
					{ day: "Thursday" },
					{ events: 7, conflicts: 1 }
				),
			},
			{
				caption: "Step 2 — it checks everyone's availability, not just yours.",
				part: toolPart(
					"mcp.gcal.check_availability",
					{ attendees: 5, window: "Thu–Fri" },
					{ slot: "Friday 10:00", all_free: true }
				),
			},
			{
				caption: "Step 3 — the meeting moves to the slot that actually works.",
				part: toolPart(
					"mcp.gcal.update_event",
					{ event: "Design review", time: "Friday 10:00" },
					{ ok: true, invites_sent: 5 }
				),
			},
			{
				caption:
					"Step 4 — and the room hears it from you, not from a silent calendar ping.",
				part: toolPart(
					"mcp.slack.send_message",
					{
						channel: "#design",
						text: "Design review moved to Fri 10:00 — clash on my side. Same agenda.",
					},
					{ ok: true }
				),
			},
		],
		close:
			"Done. Thursday is clear, Friday 10:00 works for all five, and #design already knows why. You kept the dentist.",
	},
];

/** The six parts of a scenario's assistant turn: intro, four tools, close. */
function runParts(scenario: Scenario): Part[] {
	return [
		{ type: "text", text: scenario.intro },
		...scenario.steps.map((step) => step.part),
		{ type: "text", text: scenario.close },
	];
}

const RUN_PART_COUNT = runParts(SCENARIOS[0]).length;

/** Slice the turn to `count` parts, holding the last tool row mid-run. */
function assistantParts(
	parts: Part[],
	count: number,
	pending: boolean
): UIMessage["parts"] {
	const shown = parts.slice(0, count);
	return shown.map<UIMessage["parts"][number]>((part, index) => {
		const isTool = isScriptedToolPart(part);
		if (!isTool) {
			return part;
		}
		const isLast = index === shown.length - 1;
		if (isLast && pending) {
			const { output: _output, ...rest } = part;
			return { ...rest, state: "input-available" };
		}
		return { ...part, state: "output-available" };
	});
}

/* ── the script ────────────────────────────────────────────────────────────── */

type Phase = "notice" | "accept" | "run" | "done";

interface Beat {
	caption: string;
	/** Which surface the annotation highlights on this beat. */
	focus: "island" | "desktop";
	/** ms this beat stays on screen. */
	hold: number;
	id: string;
	island: {
		cursor: "away" | "hover" | "press";
		pill?: string;
		state: Extract<IslandState, "collapsed" | "idle" | "suggestion">;
	};
	phase: Phase;
	/** Parts of the assistant turn revealed, and whether the last one is running. */
	run: { parts: number; pending: boolean; streaming: boolean };
	thread: "idle" | "task";
	trail?: boolean;
}

const RUN_BEAT = (
	id: string,
	parts: number,
	pending: boolean,
	caption: string,
	hold = 1500
): Beat => ({
	id,
	hold,
	caption,
	phase: "run",
	focus: "desktop",
	island: { state: "idle", pill: "Working", cursor: "away" },
	thread: "task",
	run: { parts, pending, streaming: true },
});

/**
 * The beat list for one scenario. Every scenario produces the SAME beats in the
 * same order — only the captions and the transcript underneath change — so the
 * indices below stay valid whichever use case is on screen.
 */
function buildBeats(scenario: Scenario): [Beat, ...Beat[]] {
	return [
		{
			id: "watch",
			hold: 1800,
			caption: "See the context, the decision, and the next step in one place.",
			phase: "notice",
			focus: "island",
			island: { state: "idle", pill: "Ryu", cursor: "away" },
			thread: "idle",
			run: { parts: 0, pending: false, streaming: false },
		},
		{
			id: "notice",
			hold: 2600,
			caption: scenario.noticeCaption,
			phase: "notice",
			focus: "island",
			island: { state: "suggestion", cursor: "away" },
			thread: "idle",
			run: { parts: 0, pending: false, streaming: false },
		},
		{
			id: "reach",
			hold: 900,
			caption: "You see the context first, then choose what happens.",
			phase: "accept",
			focus: "island",
			island: { state: "suggestion", cursor: "hover" },
			thread: "idle",
			run: { parts: 0, pending: false, streaming: false },
		},
		{
			id: "accept",
			hold: 750,
			caption: "Accept.",
			phase: "accept",
			focus: "island",
			island: { state: "suggestion", cursor: "press" },
			thread: "idle",
			run: { parts: 0, pending: false, streaming: false },
		},
		{
			id: "handoff",
			hold: 1400,
			caption:
				"The work opens with its context, permissions, and history attached.",
			phase: "run",
			focus: "desktop",
			island: { state: "idle", pill: "Handing off", cursor: "away" },
			thread: "task",
			run: { parts: 0, pending: false, streaming: true },
			trail: true,
		},
		RUN_BEAT(
			"run-intro",
			1,
			false,
			"The work opens as a readable record you can pause and revisit."
		),
		...scenario.steps.map((step, index) =>
			RUN_BEAT(
				`run-step-${index}`,
				index + 2,
				true,
				step.caption,
				index === 1 || index === 2 ? 1600 : 1500
			)
		),
		{
			id: "done",
			hold: 3200,
			caption:
				"One decision. A full record — what it read, what it changed, and what it cost.",
			phase: "done",
			focus: "desktop",
			island: { state: "idle", pill: "Done", cursor: "away" },
			thread: "task",
			run: { parts: RUN_PART_COUNT, pending: false, streaming: false },
		},
		{
			id: "rest",
			hold: 2000,
			caption:
				"Your data, your limits, and your call on what leaves the machine.",
			phase: "done",
			focus: "island",
			island: { state: "collapsed", cursor: "away" },
			thread: "task",
			run: { parts: RUN_PART_COUNT, pending: false, streaming: false },
		},
	];
}

// Structural, not per-scenario: every scenario builds the same beat list.
const BEAT_TEMPLATE = buildBeats(SCENARIOS[0]);
const BEAT_COUNT = BEAT_TEMPLATE.length;
const beatIndexOf = (id: string) =>
	BEAT_TEMPLATE.findIndex((beat) => beat.id === id);
const DONE_BEAT_INDEX = beatIndexOf("done");
const HANDOFF_BEAT_INDEX = beatIndexOf("handoff");
const REST_BEAT_INDEX = beatIndexOf("rest");

/**
 * The pills are real buttons under an animated pointer, so they have to do what
 * they say: a visitor who beats the script to the click runs the same handoff.
 */
function demoActions(jumpTo: (index: number) => void): IslandAction[] {
	return [
		{
			key: "accept",
			label: "Accept",
			primary: true,
			onClick: () => jumpTo(HANDOFF_BEAT_INDEX),
		},
		{ key: "snooze", label: "Snooze", onClick: () => jumpTo(REST_BEAT_INDEX) },
		{
			key: "dismiss",
			label: "Dismiss",
			onClick: () => jumpTo(REST_BEAT_INDEX),
		},
	];
}

/* ── the scripted island ───────────────────────────────────────────────────── */

// Where the pointer sits when it is over the Accept pill, in island-local space.
const CURSOR_TARGET = {
	x: LOGO_CIRCLE.width + SPLIT_GAP + ACTION_PILL_WIDTH / 2,
	y: LOGO_CIRCLE.height + SUGGESTION_STACK_GAP + ACTION_PILL_HEIGHT / 2,
};
const CURSOR_PARKED = { x: CURSOR_TARGET.x + 150, y: CURSOR_TARGET.y + 70 };

function DemoCursor({ mode }: { mode: Beat["island"]["cursor"] }) {
	const away = mode === "away";
	const target = away ? CURSOR_PARKED : CURSOR_TARGET;
	return (
		<motion.div
			animate={{
				x: target.x,
				y: target.y,
				opacity: away ? 0 : 1,
				scale: mode === "press" ? 0.86 : 1,
			}}
			className="pointer-events-none absolute top-0 left-0 z-30"
			initial={false}
			transition={{ type: "spring", bounce: 0.18, duration: 0.55 }}
		>
			{mode === "press" ? (
				<motion.span
					animate={{ scale: 2.2, opacity: 0 }}
					className="absolute size-6 -translate-x-1/2 -translate-y-1/2 rounded-full bg-space-paper-line-placeholder/70"
					initial={{ scale: 0.4, opacity: 0.9 }}
					transition={{ duration: 0.55 }}
				/>
			) : null}
			<svg
				aria-hidden="true"
				className={styles.pointer}
				fill="none"
				height="28"
				viewBox="0 0 16 22"
				width="20"
			>
				<title>Pointer</title>
				<path
					d="M1 1.5 13.4 12.1h-5.7l-2.3 5.6z"
					fill="var(--color-logo-mask-solid)"
					stroke="var(--color-logo-mask-clear)"
					strokeOpacity={0.75}
					strokeWidth="1.4"
				/>
			</svg>
		</motion.div>
	);
}

function IslandDetail({
	state,
	pill,
	suggestion,
}: {
	pill?: string;
	state: IslandState;
	suggestion: Scenario["suggestion"];
}) {
	if (state === "suggestion") {
		return <IslandSuggestionChip suggestion={suggestion} />;
	}
	return (
		<span className="truncate font-medium text-sm text-space-home">
			{pill ?? "Ryu"}
		</span>
	);
}

function DemoIsland({
	beat,
	jumpTo,
	suggestion,
}: {
	beat: Beat;
	jumpTo: (index: number) => void;
	suggestion: Scenario["suggestion"];
}) {
	const { state, pill, cursor } = beat.island;
	const detail = DETAIL_SIZES[state];
	const detailClass =
		state === "suggestion"
			? "flex h-full w-full items-center px-3"
			: "flex h-full w-full items-center justify-center px-4";

	return (
		<div className="relative flex flex-col items-start">
			<div
				className={cn("flex items-start", styles.split)}
				style={
					{
						"--hero-workflow-loop-gap": `${SPLIT_GAP}px`,
					} satisfies PrivateStyle as PrivateStyle
				}
			>
				<div
					className={cn(
						`${ISLAND_SURFACE_BASE} ${TRANSLUCENT_SKIN}`,
						styles.logoCircle
					)}
					style={
						{
							"--hero-workflow-loop-width": `${LOGO_CIRCLE.width}px`,
							"--hero-workflow-loop-height": `${LOGO_CIRCLE.height}px`,
							"--hero-workflow-loop-border-radius": `${LOGO_CIRCLE.radius}px`,
						} satisfies PrivateStyle as PrivateStyle
					}
				>
					<div className="flex h-full w-full items-center justify-center">
						<RyuLogo size="34px" tone="inherit" variant="eyes" />
					</div>
				</div>

				<AnimatePresence initial={false}>
					{detail ? (
						<motion.div
							animate={{
								width: detail.width,
								height: detail.height,
								borderRadius: detail.radius,
								opacity: 1,
							}}
							className={`${ISLAND_SURFACE_BASE} ${TRANSLUCENT_SKIN}`}
							exit={{ width: 0, opacity: 0 }}
							initial={{ width: 0, opacity: 0 }}
							key="detail"
							transition={ISLAND_SPRING}
						>
							<AnimatePresence initial={false} mode="wait">
								<motion.div
									animate={{ opacity: 1, scale: 1, y: 0 }}
									className={detailClass}
									exit={{ opacity: 0, scale: 0.92, y: -6 }}
									initial={{ opacity: 0, scale: 0.92, y: 6 }}
									key={`${state}-${pill ?? ""}`}
									transition={CONTENT_SPRING}
								>
									<IslandDetail
										pill={pill}
										state={state}
										suggestion={suggestion}
									/>
								</motion.div>
							</AnimatePresence>
						</motion.div>
					) : null}
				</AnimatePresence>
			</div>

			<AnimatePresence initial={false}>
				{state === "suggestion" ? (
					<motion.div exit={{ opacity: 0, y: -6 }} key="pills">
						<IslandActionPills
							actions={demoActions(jumpTo)}
							pressedKey={cursor === "press" ? "accept" : null}
						/>
					</motion.div>
				) : null}
			</AnimatePresence>

			<DemoCursor mode={cursor} />
		</div>
	);
}

/**
 * The three dots that travel from the island to the window on the handoff. It
 * spans the island band AND the window, so the dots cross the wallpaper gap the
 * way the handoff actually reads — top-centre, down into the transcript.
 */
function HandoffTrail({ shown }: { shown: boolean }) {
	if (!shown) {
		return null;
	}
	return (
		<div
			aria-hidden="true"
			className="pointer-events-none absolute inset-0 z-20"
		>
			{[0, 1, 2].map((index) => (
				<motion.span
					animate={{ left: "56%", top: "46%", opacity: [0, 1, 0] }}
					className={cn("absolute size-1.5 rounded-full", styles.trail)}
					initial={{ left: "50%", top: "12%", opacity: 0 }}
					key={`trail-${index}`}
					transition={{ duration: 0.9, delay: index * 0.16, ease: "easeOut" }}
				/>
			))}
		</div>
	);
}

/* ── the desktop half ──────────────────────────────────────────────────────── */

/**
 * The use-case pills. Rendered by `hero.tsx` ABOVE the wallpaper, not inside the
 * stage: sitting on the desktop background they read as chrome belonging to the
 * mock app, and the point of them is the opposite — that the loop is not one
 * canned demo, and a visitor can jump straight to the job that is theirs.
 *
 * Stock `TabsList variant="pills-lg"`, styled by nothing here. This was briefly
 * a hand-rolled button row carrying its own border, shadow and colour rules,
 * which is how a surface drifts out of the design system one override at a time.
 */
export function HeroUseCaseSwitcher({
	current,
	onPick,
}: {
	current: number;
	onPick: (index: number) => void;
}) {
	return (
		<Tabs
			onValueChange={(value) => onPick(Number(value))}
			value={String(current)}
		>
			<TabsList className="mx-auto" variant="pills-lg">
				{SCENARIOS.map((scenario, index) => (
					<TabsTrigger key={scenario.id} value={String(index)}>
						{scenario.label}
					</TabsTrigger>
				))}
			</TabsList>
		</Tabs>
	);
}

/* ── the stage: a fixed-size window, scaled to whatever width it gets ──────── */

// The desktop window is drawn at ONE size and scaled to fit. A real desktop
// sidebar + transcript reflowed into a 390px phone reads as a broken app, not a
// small one — so the mock keeps its proportions and shrinks, cropping its right
// edge below the floor scale rather than squeezing the layout.
const STAGE_WIDTH = 1120;
const STAGE_HEIGHT = 600;
const MIN_STAGE_SCALE = 0.5;

// The strip of wallpaper the island owns, above the window. Tall enough for the
// island's tallest state (suggestion chip + the pill row that morphs out under
// it) and fixed, not min-height: the island is hidden during a takeover, and a
// collapsing band would make the window jump the moment a visitor types. It is
// drawn at stage scale so the island keeps its proportion to the app it sits on.
const SUGGESTION_DETAIL_HEIGHT = DETAIL_SIZES.suggestion?.height ?? 62;
const ISLAND_BAND =
	SUGGESTION_DETAIL_HEIGHT + SUGGESTION_STACK_GAP + ACTION_PILL_HEIGHT;
const ISLAND_BAND_GAP = 18;

function useStageScale() {
	const frameRef = useRef<HTMLDivElement>(null);
	const [scale, setScale] = useState(1);

	useEffect(() => {
		const node = frameRef.current;
		if (!node) {
			return;
		}
		const observer = new ResizeObserver(([entry]) => {
			const width = entry?.contentRect.width ?? STAGE_WIDTH;
			// No upper cap: on a wide container the window fills the frame rather
			// than leaving a gap down its right-hand side.
			setScale(Math.max(MIN_STAGE_SCALE, width / STAGE_WIDTH));
		});
		observer.observe(node);
		return () => observer.disconnect();
	}, []);

	return { frameRef, scale };
}

/* ── the loop ──────────────────────────────────────────────────────────────── */

const TAKEOVER_REPLY =
	"Happy to. Ryu will show the context it used, pause before anything sensitive, and leave the record behind when it is done.";

function useBeatLoop(
	paused: boolean,
	scenarioIndex: number,
	setScenarioIndex: (next: number) => void
) {
	const reduceMotion = useReducedMotion();
	const [index, setIndex] = useState(0);
	const [visible, setVisible] = useState(true);
	const stageRef = useRef<HTMLDivElement>(null);
	const scenario = SCENARIOS[scenarioIndex] ?? SCENARIOS[0];
	// Read inside the beat timer so a lap wrap advances from the CURRENT use
	// case without the timer having to re-arm every time one is picked.
	const scenarioIndexRef = useRef(scenarioIndex);
	scenarioIndexRef.current = scenarioIndex;
	const beats = useMemo(() => buildBeats(scenario), [scenario]);

	// Reduced motion: skip straight to the finished run and never advance.
	useEffect(() => {
		if (reduceMotion) {
			setIndex(DONE_BEAT_INDEX);
		}
	}, [reduceMotion]);

	// Only spend frames on a loop the visitor can actually see.
	useEffect(() => {
		const node = stageRef.current;
		if (!node) {
			return;
		}
		const observer = new IntersectionObserver(
			([entry]) => setVisible(Boolean(entry?.isIntersecting)),
			{ threshold: 0.15 }
		);
		observer.observe(node);
		return () => observer.disconnect();
	}, []);

	// The wrap is computed here rather than inside the state updater: React can
	// invoke an updater twice, and a scenario bump hidden in one would skip a use
	// case on every lap.
	useEffect(() => {
		if (reduceMotion || paused || !visible) {
			return;
		}
		const timer = window.setTimeout(() => {
			const next = index + 1;
			if (next < BEAT_COUNT) {
				setIndex(next);
				return;
			}
			setScenarioIndex((scenarioIndexRef.current + 1) % SCENARIOS.length);
			setIndex(0);
		}, beats[index]?.hold ?? 1500);
		return () => window.clearTimeout(timer);
	}, [index, paused, visible, reduceMotion, beats, setScenarioIndex]);

	/** Jump straight to a use case — from the switcher chips. */
	const pickScenario = useCallback(
		(next: number) => {
			setScenarioIndex(next);
			setIndex(0);
		},
		[setScenarioIndex]
	);

	return {
		beat: beats[index] ?? beats[0],
		index,
		pickScenario,
		scenario,
		scenarioIndex,
		setIndex,
		stageRef,
		visible,
	};
}

export function HeroWorkflowLoop({
	scenarioIndex,
	onScenarioChange,
}: {
	onScenarioChange: (next: number) => void;
	scenarioIndex: number;
}) {
	// While the visitor is typing in the demo, the script stops and the chat is
	// theirs — the same "take it over" affordance the old showcase had.
	const [takeover, setTakeover] = useState<UIMessage[] | null>(null);
	const [takeoverStatus, setTakeoverStatus] = useState<ChatStatus>("ready");
	const { beat, scenario, setIndex, stageRef, visible } = useBeatLoop(
		takeover !== null,
		scenarioIndex,
		onScenarioChange
	);
	const { frameRef, scale } = useStageScale();

	// One island on screen: stand the persistent site island down while the stage
	// is in view — it draws its own — and hand it back once the visitor scrolls
	// past, so the rest of the page keeps its floating island.
	useEffect(() => {
		setIslandSuppressed(visible);
		return () => setIslandSuppressed(false);
	}, [visible]);

	const scriptedMessages = useMemo<UIMessage[]>(() => {
		if (beat.thread === "idle") {
			return [
				textMessage("idle-user", "user", scenario.idle.question),
				textMessage("idle-assistant", "assistant", scenario.idle.answer),
			];
		}
		const messages: UIMessage[] = [
			textMessage("task-user", "user", scenario.prompt),
		];
		if (beat.run.parts > 0) {
			messages.push({
				id: "task-assistant",
				role: "assistant",
				parts: assistantParts(
					runParts(scenario),
					beat.run.parts,
					beat.run.pending
				),
			});
		}
		return messages;
	}, [beat, scenario]);

	const messages = takeover ?? scriptedMessages;

	const onSend = useCallback(
		(message: { role: "user"; content: string }) => {
			const trimmed = message.content.trim();
			if (!trimmed) {
				return;
			}
			const base = takeover ?? scriptedMessages;
			setTakeover([
				...base,
				textMessage(`takeover-${base.length}`, "user", trimmed),
			]);
			setTakeoverStatus("streaming");
			window.setTimeout(() => {
				setTakeover((prev) =>
					prev
						? [
								...prev,
								textMessage(
									`takeover-reply-${prev.length}`,
									"assistant",
									TAKEOVER_REPLY
								),
							]
						: prev
				);
				setTakeoverStatus("ready");
			}, 700);
		},
		[scriptedMessages, takeover]
	);

	const restart = useCallback(() => {
		setTakeover(null);
		setTakeoverStatus("ready");
		setIndex(0);
	}, [setIndex]);

	// The switcher now lives outside this component, so the takeover is cleared
	// on the scenario CHANGE rather than in the click handler.

	// scenario changing, which is the whole trigger — the setters are stable.
	useEffect(() => {
		setTakeover(null);
		setTakeoverStatus("ready");
	}, [scenarioIndex]);

	const status: ChatStatus = takeover
		? takeoverStatus
		: beat.run.streaming && beat.run.pending
			? "streaming"
			: "ready";

	return (
		<div className="mx-auto w-full min-w-0 max-w-6xl overflow-x-clip">
			<div className="relative min-w-0">
				{/* The island is OUTSIDE the window — it sits on the hero's background
				    image, which is standing in for the desktop wallpaper. It is scaled
				    with the window (it lives outside the stage's own transform, so it
				    would otherwise render 1:1 and dwarf a shrunken app on narrow
				    viewports) and centred, the way an always-on-top pill parks. */}
				<div
					className={cn("relative", styles.islandBand)}
					style={
						{
							"--hero-workflow-loop-height": `${(ISLAND_BAND + ISLAND_BAND_GAP) * scale}px`,
						} satisfies PrivateStyle as PrivateStyle
					}
				>
					{takeover ? null : (
						<div
							className={cn(
								"absolute top-0 left-1/2 z-30",
								styles.scaledIsland
							)}
							style={
								{
									"--hero-workflow-loop-transform": `translateX(-50%) scale(${scale})`,
									"--hero-workflow-loop-transform-origin": "top center",
								} satisfies PrivateStyle as PrivateStyle
							}
						>
							<DemoIsland
								beat={beat}
								jumpTo={setIndex}
								suggestion={scenario.suggestion}
							/>
						</div>
					)}
				</div>

				<div
					className={cn(
						cn(
							"w-full min-w-0 overflow-hidden rounded-2xl shadow-2xl ring-1 duration-500",
							beat.focus === "desktop" && !takeover
								? "ring-foreground/25"
								: "ring-border"
						),
						styles.frameHeight,
						styles.frame
					)}
					ref={frameRef}
					style={
						{
							"--hero-workflow-loop-height": `${STAGE_HEIGHT * scale}px`,
						} satisfies PrivateStyle as PrivateStyle
					}
				>
					<div
						className={cn(
							"relative origin-top-left bg-background",
							styles.stage
						)}
						data-beat-id={beat.id}
						data-scenario-id={scenario.id}
						data-testid="hero-workflow-stage"
						ref={stageRef}
						style={
							{
								"--hero-workflow-loop-width": `${STAGE_WIDTH}px`,
								"--hero-workflow-loop-height": `${STAGE_HEIGHT}px`,
								"--hero-workflow-loop-transform": `scale(${scale})`,
							} satisfies PrivateStyle as PrivateStyle
						}
					>
						<DesktopShell sidebarMode="trust">
							{/* No fabricated "Agent / Model / Space" top bar. The real app
							    has no such row — those controls live in the composer
							    (`useComposerAgentControls`), so a mock that invents one is
							    showing a product we do not ship. What is left is AgentChat,
							    which IS the shipped component. */}
							<AgentChat
								messages={messages}
								onSend={onSend}
								onStop={() => setTakeoverStatus("ready")}
								status={status}
							/>
						</DesktopShell>
					</div>
				</div>

				<HandoffTrail shown={Boolean(beat.trail) && !takeover} />
			</div>

			{/* No phase strip, surface legend or step caption. They narrated the
			    demo for the reader — "Island notices › You accept", "Always on top ·
			    one glance, one click", "Step 3 — it logs the outcome" — which is a
			    description of how we built it rather than anything about their work.
			    The stage shows the job running; that is the whole point of showing it.
			    The use-case pills now live in `hero.tsx`, above the wallpaper. */}
			{takeover ? (
				<div className="mt-4 flex justify-center">
					<Button onClick={restart} size="sm" variant="secondary">
						Replay the workflow
					</Button>
				</div>
			) : null}
		</div>
	);
}

export default HeroWorkflowLoop;

interface PrivateStyle extends CSSProperties {
	"--hero-workflow-loop-border-radius"?: string;
	"--hero-workflow-loop-gap"?: string;
	"--hero-workflow-loop-height"?: string;
	"--hero-workflow-loop-transform"?: CSSProperties["transform"];
	"--hero-workflow-loop-transform-origin"?: CSSProperties["transformOrigin"];
	"--hero-workflow-loop-width"?: string;
}
