// Standalone browser story for the four workspace interfaces — Channels, Feed,
// World 2D and World 3D — mounting the REAL renderers from
// `packages/blocks/src/desktop/interfaces/`.
//
// Renderers are pure presentation: they read an `InterfaceSnapshot`, act
// through an `InterfacePort`, and show the host's chat surface as
// `threadView`. This story is the host. It owns a realistic fixture snapshot
// (six agents, a team, a project, ten threads with two runs live), implements
// the port by opening/starting threads in local state, and passes a clearly
// labelled stub in place of the desktop's real ChatPage. Every port call is
// echoed into a visible log so the spec can assert the renderer used the port
// rather than any side channel.
//
// Query params:
//   ?interface=channels|feed|world-2d|world-3d   which renderer to mount
//   &thread=<id>                                  open a thread on load
//   &groupBy=agent|project                        Channels param (default project)
//   &order=recent|active                          Feed param
//   &theme=meadow|night|office                    World themes
//   &camera=orbit|isometric                       World 3D camera
//   &view=board|list                              Board view (groupBy=status|agent|project)
//   &arrange=status|agent                         Canvas starting layout
//   &layout=poker|spread                          Card Table layout
//   &season=auto|advent|halloween|lunar-new-year  Seasonal board
//   &scale=month|week                             Calendar scale (Timeline: day|week)
//   &demo=life                                    cycle a few threads through states every
//                                                 few seconds; alone (no interface), mounts
//                                                 the 3D kit's act-layer demo island on the
//                                                 useful-state fixture, moving through its
//                                                 phases; &phase=0..3 (or &hold=1) holds one:
//                                                 default, live permission, Bo's ask about to
//                                                 expire, redacted; &capacity=N gives the
//                                                 island N stations (the rest off stage)
//   &fixture=useful                               the useful-state fixture (asks, acts) with a
//                                                 frozen clock at the fixture's now, en-GB / UTC
//     &privacy=redacted                           the host-redacted fixture
//     &livePermission=1                           Ada running with a live permission ask
//     &agents=ada,bo                              only these agents (and their threads / asks);
//                                                 a bare number keeps the first N fixture
//                                                 agents (capped at the fixture's 10)
//     &noAsks=1                                   the old-host snapshot (no act fields), for S14
//   answerAsk / openInbox are spied into the port log; answering removes the ask.
//   &agents=<n>                                   Show n agents (fewer: their threads only;
//                                                 more: extra idle agents, for crowd checks)

import { AquariumInterface } from "@ryu/blocks/desktop/interfaces/aquarium-interface.tsx";
import { ArcadeInterface } from "@ryu/blocks/desktop/interfaces/arcade-interface.tsx";
import { ArenaInterface } from "@ryu/blocks/desktop/interfaces/arena-interface.tsx";
import { BankInterface } from "@ryu/blocks/desktop/interfaces/bank-interface.tsx";
import { BoardInterface } from "@ryu/blocks/desktop/interfaces/board-interface.tsx";
import { CalendarInterface } from "@ryu/blocks/desktop/interfaces/calendar-interface.tsx";
import { CanvasInterface } from "@ryu/blocks/desktop/interfaces/canvas-interface.tsx";
import { CardTableInterface } from "@ryu/blocks/desktop/interfaces/card-table-interface.tsx";
import { ChannelsInterface } from "@ryu/blocks/desktop/interfaces/channels-interface.tsx";
import { CinemaInterface } from "@ryu/blocks/desktop/interfaces/cinema-interface.tsx";
import { CommunityInterface } from "@ryu/blocks/desktop/interfaces/community-interface.tsx";
import { DashboardInterface } from "@ryu/blocks/desktop/interfaces/dashboard-interface.tsx";
import { DeparturesInterface } from "@ryu/blocks/desktop/interfaces/departures-interface.tsx";
import { DeskInterface } from "@ryu/blocks/desktop/interfaces/desk-interface.tsx";
import { FarmInterface } from "@ryu/blocks/desktop/interfaces/farm-interface.tsx";
import { FeedInterface } from "@ryu/blocks/desktop/interfaces/feed-interface.tsx";
import { FlowInterface } from "@ryu/blocks/desktop/interfaces/flow-interface.tsx";
import { FocusInterface } from "@ryu/blocks/desktop/interfaces/focus-interface.tsx";
import { ForumInterface } from "@ryu/blocks/desktop/interfaces/forum-interface.tsx";
import { GalleryInterface } from "@ryu/blocks/desktop/interfaces/gallery-interface.tsx";
import {
	FIXTURE_AGENT_IDS,
	FIXTURE_CLOCK,
	FIXTURE_NOW,
	usefulStateFixture,
} from "@ryu/blocks/desktop/interfaces/game-acts-fixture.ts";
import { LifeDemo } from "@ryu/blocks/desktop/interfaces/game3d-life-demo.tsx";
import { GlanceInterface } from "@ryu/blocks/desktop/interfaces/glance-interface.tsx";
import { GraphInterface } from "@ryu/blocks/desktop/interfaces/graph-interface.tsx";
import { HologramInterface } from "@ryu/blocks/desktop/interfaces/hologram-interface.tsx";
import { HubInterface } from "@ryu/blocks/desktop/interfaces/hub-interface.tsx";
import { InboxInterface } from "@ryu/blocks/desktop/interfaces/inbox-interface.tsx";
import { JobsInterface } from "@ryu/blocks/desktop/interfaces/jobs-interface.tsx";
import { JournalInterface } from "@ryu/blocks/desktop/interfaces/journal-interface.tsx";
import { KitchenInterface } from "@ryu/blocks/desktop/interfaces/kitchen-interface.tsx";
import { KnowledgeInterface } from "@ryu/blocks/desktop/interfaces/knowledge-interface.tsx";
import { LibraryInterface } from "@ryu/blocks/desktop/interfaces/library-interface.tsx";
import { LiveInterface } from "@ryu/blocks/desktop/interfaces/live-interface.tsx";
import { LobbyInterface } from "@ryu/blocks/desktop/interfaces/lobby-interface.tsx";
import { MailInterface } from "@ryu/blocks/desktop/interfaces/mail-interface.tsx";
import { MarketInterface } from "@ryu/blocks/desktop/interfaces/market-interface.tsx";
import { MessengerInterface } from "@ryu/blocks/desktop/interfaces/messenger-interface.tsx";
import { MindmapInterface } from "@ryu/blocks/desktop/interfaces/mindmap-interface.tsx";
import { MissionControlInterface } from "@ryu/blocks/desktop/interfaces/mission-control-interface.tsx";
import { MomentsInterface } from "@ryu/blocks/desktop/interfaces/moments-interface.tsx";
import { NewspaperInterface } from "@ryu/blocks/desktop/interfaces/newspaper-interface.tsx";
import { NotebookInterface } from "@ryu/blocks/desktop/interfaces/notebook-interface.tsx";
import { NoticeboardInterface } from "@ryu/blocks/desktop/interfaces/noticeboard-interface.tsx";
import { PanelsInterface } from "@ryu/blocks/desktop/interfaces/panels-interface.tsx";
import { PassportInterface } from "@ryu/blocks/desktop/interfaces/passport-interface.tsx";
import { PathInterface } from "@ryu/blocks/desktop/interfaces/path-interface.tsx";
import { PersonaInterface } from "@ryu/blocks/desktop/interfaces/persona-interface.tsx";
import { PlanetsInterface } from "@ryu/blocks/desktop/interfaces/planets-interface.tsx";
import { PostsInterface } from "@ryu/blocks/desktop/interfaces/posts-interface.tsx";
import { QaInterface } from "@ryu/blocks/desktop/interfaces/qa-interface.tsx";
import { QuizInterface } from "@ryu/blocks/desktop/interfaces/quiz-interface.tsx";
import { RecordsInterface } from "@ryu/blocks/desktop/interfaces/records-interface.tsx";
import { RidesInterface } from "@ryu/blocks/desktop/interfaces/rides-interface.tsx";
import { SeasonalInterface } from "@ryu/blocks/desktop/interfaces/seasonal-interface.tsx";
import { SheetInterface } from "@ryu/blocks/desktop/interfaces/sheet-interface.tsx";
import { StatusInterface } from "@ryu/blocks/desktop/interfaces/status-interface.tsx";
import { StreamInterface } from "@ryu/blocks/desktop/interfaces/stream-interface.tsx";
import { TerminalInterface } from "@ryu/blocks/desktop/interfaces/terminal-interface.tsx";
import { TickerInterface } from "@ryu/blocks/desktop/interfaces/ticker-interface.tsx";
import { TicketsInterface } from "@ryu/blocks/desktop/interfaces/tickets-interface.tsx";
import { TimelineInterface } from "@ryu/blocks/desktop/interfaces/timeline-interface.tsx";
import { TownInterface } from "@ryu/blocks/desktop/interfaces/town-interface.tsx";
import { TrackingInterface } from "@ryu/blocks/desktop/interfaces/tracking-interface.tsx";
import { ActClockProvider } from "@ryu/blocks/desktop/interfaces/use-acts.ts";
import { WarehouseInterface } from "@ryu/blocks/desktop/interfaces/warehouse-interface.tsx";
import { WikiInterface } from "@ryu/blocks/desktop/interfaces/wiki-interface.tsx";
import { WorkersInterface } from "@ryu/blocks/desktop/interfaces/workers-interface.tsx";
import { World2dInterface } from "@ryu/blocks/desktop/interfaces/world-2d-interface.tsx";
import { World3dInterface } from "@ryu/blocks/desktop/interfaces/world-3d-interface.tsx";
import { applyVariant } from "@ryu/ui/theme/apply.ts";
import { THEME_VARIANTS } from "@ryu/ui/theme/presets.ts";
import {
	builtinInterfaceId,
	INTERFACE_PROTOCOL_VERSION,
	type InterfaceAccount,
	type InterfaceAccountTransaction,
	type InterfaceAgent,
	type InterfaceEvent,
	type InterfaceGroup,
	type InterfacePort,
	type InterfaceSnapshot,
	type InterfaceThread,
	resolveInterfaceParams,
} from "@ryuhq/protocol/interfaces";
import {
	type ReactNode,
	useCallback,
	useEffect,
	useMemo,
	useState,
} from "react";
import { createRoot } from "react-dom/client";
import { InterfaceFrame } from "../../src/interfaces/InterfaceFrame.tsx";
import { useInterfaceStore } from "../../src/interfaces/interface-store.ts";
import { useProductModeStore } from "../../src/lib/product-mode.ts";
import "../../src/index.css";

const STORY_RENDERERS = [
	"channels",
	"feed",
	"world-2d",
	"world-3d",
	"board",
	"inbox",
	"graph",
	"timeline",
	"messenger",
	"terminal",
	"arena",
	"desk",
	"card-table",
	"sheet",
	"canvas",
	"calendar",
	"notebook",
	"mission-control",
	"ticker",
	"focus",
	"aquarium",
	"planets",
	"stream",
	"forum",
	"live",
	"posts",
	"community",
	"wiki",
	"dashboard",
	"mindmap",
	"gallery",
	"newspaper",
	"qa",
	"cinema",
	"noticeboard",
	"mail",
	"status",
	"records",
	"path",
	"glance",
	"hub",
	"library",
	"tickets",
	"persona",
	"panels",
	"departures",
	"tracking",
	"flow",
	"moments",
	"kitchen",
	"market",
	"workers",
	"arcade",
	"farm",
	"town",
	"rides",
	"journal",
	"passport",
	"lobby",
	"seasonal",
	"bank",
	"quiz",
	"jobs",
	"knowledge",
	"hologram",
	"warehouse",
] as const;
type StoryRenderer = (typeof STORY_RENDERERS)[number];

const MINUTE = 60_000;
const NOW = Date.now();
const ago = (minutes: number) => new Date(NOW - minutes * MINUTE).toISOString();

const AGENTS: InterfaceAgent[] = [
	{
		avatarUrl: null,
		description: "Digs through papers, docs and the web",
		id: "agent-atlas",
		name: "Atlas",
		status: "idle",
	},
	{
		avatarUrl: null,
		description: "Product and visual design",
		id: "agent-brook",
		name: "Brook",
		status: "idle",
	},
	{
		avatarUrl: null,
		description: "Security reviews and dependency audits",
		id: "agent-cipher",
		name: "Cipher",
		status: "idle",
	},
	{
		avatarUrl: null,
		description: "Deploys, alerts and on-call runbooks",
		id: "agent-delta",
		name: "Delta",
		status: "working",
	},
	{
		avatarUrl: null,
		description: "Release notes, docs and announcements",
		id: "agent-echo",
		name: "Echo",
		status: "idle",
	},
	{
		avatarUrl: null,
		description: "Full-stack engineer",
		id: "agent-forge",
		name: "Forge",
		status: "working",
	},
];

const GROUPS: InterfaceGroup[] = [
	{
		id: "team-launch",
		kind: "team",
		memberAgentIds: ["agent-atlas", "agent-echo", "agent-forge"],
		name: "Launch Crew",
	},
	{
		id: "project-website",
		kind: "project",
		memberAgentIds: ["agent-brook", "agent-forge"],
		name: "Website Redesign",
	},
];

function thread(
	input: Partial<InterfaceThread> & Pick<InterfaceThread, "id" | "title">
): InterfaceThread {
	return {
		agentIds: [],
		lastMessage: null,
		lastMessageRole: "assistant",
		messageCount: 2,
		pinned: false,
		projectId: null,
		running: false,
		teamId: null,
		updatedAt: ago(60),
		...input,
	};
}

const THREADS: InterfaceThread[] = [
	thread({
		agentIds: ["agent-forge"],
		id: "thread-hero",
		lastMessage:
			"Swapping the hero to the new type scale now; the CLS regression came from the late-loading font, so I'm preloading it.",
		messageCount: 9,
		projectId: "project-website",
		running: true,
		title: "Rebuild the landing hero",
		updatedAt: ago(1),
	}),
	thread({
		agentIds: ["agent-delta"],
		id: "thread-deploy",
		lastMessage:
			"Canary is at 25% with error rate flat. Promoting to 50% in five minutes unless you say stop.",
		messageCount: 14,
		running: true,
		title: "Roll out gateway 2.4 to production",
		updatedAt: ago(3),
	}),
	thread({
		agentIds: ["agent-atlas", "agent-echo", "agent-forge"],
		id: "thread-launch-plan",
		lastMessage:
			"Plan locked: Forge ships the build Tuesday, Echo drafts the post Wednesday, Atlas preps the competitor comparison.",
		messageCount: 22,
		pinned: true,
		teamId: "team-launch",
		title: "Launch week plan",
		updatedAt: ago(18),
	}),
	thread({
		agentIds: ["agent-brook"],
		id: "thread-palette",
		lastMessage:
			"Here are three palette directions. B keeps contrast above 4.5:1 for every text token in dark mode.",
		messageCount: 6,
		projectId: "project-website",
		title: "Pick a palette for the marketing site",
		updatedAt: ago(42),
	}),
	thread({
		agentIds: ["agent-cipher"],
		id: "thread-audit",
		lastMessage:
			"Two advisories affect us: one is dev-only, the other needs a patch release of the image library.",
		messageCount: 5,
		// A failed run, so "Needs attention" views have something real to show.
		runState: "failed",
		title: "Audit lockfile advisories",
		updatedAt: ago(95),
	}),
	thread({
		agentIds: ["agent-echo"],
		id: "thread-release-notes",
		lastMessage:
			"Drafted the 2.4 release notes. I kept the breaking change about config paths at the top.",
		messageCount: 4,
		title: "Draft 2.4 release notes",
		updatedAt: ago(160),
	}),
	thread({
		agentIds: ["agent-atlas"],
		id: "thread-research",
		lastMessage:
			"Can you add the Medusa and EAGLE-2 results and compare them on latency?",
		// The user asked a follow-up that has not started running yet.
		lastMessageRole: "user",
		messageCount: 4,
		title: "Survey speculative decoding papers",
		updatedAt: ago(60 * 7),
	}),
	thread({
		agentIds: ["agent-echo"],
		id: "thread-changelog",
		lastMessage: "Changelog style guide is in the docs folder now.",
		messageCount: 2,
		title: "Write a changelog style guide",
		updatedAt: ago(60 * 26),
	}),
	thread({
		agentIds: ["agent-delta"],
		id: "thread-runbook",
		lastMessage:
			"Runbook updated with the new rollback command and the Grafana panel to watch.",
		messageCount: 7,
		title: "Update the on-call runbook",
		updatedAt: ago(60 * 50),
	}),
	thread({
		agentIds: [],
		id: "thread-general",
		lastMessage: "Reminder: the office is closed on Friday.",
		lastMessageRole: "user",
		messageCount: 1,
		title: "Office closed Friday",
		updatedAt: ago(60 * 24 * 9),
	}),
];

const HOUR = 60 * MINUTE;
const at = (hoursFromNow: number) =>
	new Date(NOW + hoursFromNow * HOUR).toISOString();

/**
 * Scheduled runs around now, the way the desktop's routines produce them:
 * past runs with outcomes, projected upcoming runs, and one collapsed
 * high-frequency marker.
 */
const EVENTS: InterfaceEvent[] = [
	{
		agentId: "agent-delta",
		end: at(-71.9),
		id: "event-backup-past",
		kind: "past",
		label: "Daily at 6 AM",
		outcome: "success",
		start: at(-72),
		title: "Nightly backup check",
	},
	{
		agentId: "agent-cipher",
		end: at(-25.8),
		id: "event-audit-past",
		kind: "past",
		label: "Every Monday at 9 AM",
		outcome: "failure",
		start: at(-26),
		title: "Dependency audit",
	},
	{
		agentId: "agent-delta",
		end: at(-2.9),
		id: "event-backup-today",
		kind: "past",
		label: "Daily at 6 AM",
		outcome: "success",
		start: at(-3),
		title: "Nightly backup check",
	},
	{
		agentId: "agent-echo",
		count: 24,
		id: "event-inbox-sweep",
		kind: "upcoming",
		label: "Every hour",
		start: at(1),
		title: "Inbox sweep",
	},
	{
		agentId: "agent-atlas",
		id: "event-standup",
		kind: "upcoming",
		label: "Weekdays at 9 AM",
		start: at(20),
		title: "Standup summary",
	},
	{
		agentId: "agent-brook",
		id: "event-digest",
		kind: "upcoming",
		label: "Fridays at 5 PM",
		start: at(70),
		title: "Weekly design digest",
	},
	{
		agentId: null,
		id: "event-report",
		kind: "upcoming",
		label: "First of the month",
		start: at(24 * 9),
		title: "Monthly usage report",
	},
];

const SPEND_THREADS = [
	"thread-hero",
	"thread-audit",
	"thread-research",
	"thread-deploy",
	null,
] as const;
const MODELS = [
	["claude-sonnet", "anthropic"],
	["gpt-mini", "openai"],
	["llama-70b", "groq"],
] as const;

/** Thirty days of believable spend plus a top-up and the monthly plan grant. */
const TRANSACTIONS: InterfaceAccountTransaction[] = (() => {
	const rows: InterfaceAccountTransaction[] = [];
	let balance = 18_420_000;
	for (let index = 0; index < 34; index += 1) {
		const [model, provider] = MODELS[index % MODELS.length] ?? MODELS[0];
		const inputTokens = 800 + ((index * 3779) % 9000);
		const outputTokens = 200 + ((index * 1931) % 2400);
		const amount = -Math.round((inputTokens * 3 + outputTokens * 15) / 10);
		rows.push({
			amount,
			at: new Date(NOW - (index * 21 + 7) * HOUR).toISOString(),
			balanceAfter: balance,
			id: `txn-${index}`,
			inputTokens,
			kind: "debit",
			label: ["Agent run", "Tool call", "Summarise thread", "Web research"][
				index % 4
			] as string,
			model,
			outputTokens,
			provider,
			threadId: SPEND_THREADS[index % SPEND_THREADS.length] ?? null,
		});
		balance -= amount;
	}
	rows.splice(6, 0, {
		amount: 10_000_000,
		at: new Date(NOW - 5 * 24 * HOUR).toISOString(),
		balanceAfter: balance,
		id: "txn-topup",
		inputTokens: null,
		kind: "credit",
		label: "Top-up",
		model: null,
		outputTokens: null,
		provider: null,
		threadId: null,
	});
	return rows;
})();

const ACCOUNT: InterfaceAccount = {
	balance: 18_420_000,
	breakdown: { gift: 1_000_000, plan: 7_420_000, topup: 10_000_000 },
	currency: "usd",
	transactions: TRANSACTIONS,
};

const FIXTURE: InterfaceSnapshot = {
	account: ACCOUNT,
	agents: AGENTS,
	events: EVENTS,
	groups: GROUPS,
	threads: THREADS,
	version: INTERFACE_PROTOCOL_VERSION,
};

/** `&demo=life`: how often, and which threads, the demo moves on. */
const DEMO_SECONDS = 6;
const DEMO_THREADS = 4;
/** The states a demo thread walks through: working, your turn, failed. */
const DEMO_STATES: Pick<
	InterfaceThread,
	"lastMessageRole" | "running" | "runState"
>[] = [
	{ lastMessageRole: "user", running: true, runState: "running" },
	{ lastMessageRole: "assistant", running: false, runState: "completed" },
	{ lastMessageRole: "user", running: true, runState: "running" },
	{ lastMessageRole: "assistant", running: false, runState: "failed" },
];

/** The snapshot with the first few threads moved `tick` states along. */
function demoSnapshot(
	snapshot: InterfaceSnapshot,
	tick: number
): InterfaceSnapshot {
	return {
		...snapshot,
		threads: snapshot.threads.map((item, index) => {
			if (index >= DEMO_THREADS) {
				return item;
			}
			const state =
				DEMO_STATES[(tick + index) % DEMO_STATES.length] ?? DEMO_STATES[0];
			return { ...item, ...state, updatedAt: ago(0) };
		}),
	};
}

function useDemoTick(enabled: boolean): number {
	const [tick, setTick] = useState(0);
	useEffect(() => {
		if (!enabled) {
			return;
		}
		const timer = window.setInterval(
			() => setTick((value) => value + 1),
			DEMO_SECONDS * 1000
		);
		return () => window.clearInterval(timer);
	}, [enabled]);
	return tick;
}

const EXTRA_NAMES = [
	"Gale",
	"Haze",
	"Iris",
	"Juno",
	"Kite",
	"Lumen",
	"Moss",
	"Nova",
	"Onyx",
	"Pike",
];

/** The fixture with `count` agents: trimmed, or padded with idle extras. */
function withAgentCount(
	fixture: InterfaceSnapshot,
	count: number
): InterfaceSnapshot {
	if (!Number.isFinite(count) || count < 1 || count === fixture.agents.length) {
		return fixture;
	}
	if (count < fixture.agents.length) {
		const kept = fixture.agents.slice(0, count);
		const ids = new Set(kept.map((agent) => agent.id));
		return {
			...fixture,
			agents: kept,
			threads: fixture.threads.filter((thread) =>
				thread.agentIds.every((id) => ids.has(id))
			),
		};
	}
	const extras = Array.from(
		{ length: count - fixture.agents.length },
		(_, index): InterfaceAgent => {
			const name = EXTRA_NAMES[index % EXTRA_NAMES.length] ?? "Agent";
			return {
				avatarUrl: null,
				description: "An extra agent for crowd checks",
				id: `agent-extra-${index}`,
				name: index < EXTRA_NAMES.length ? name : `${name} ${index}`,
				status: "idle",
			};
		}
	);
	return { ...fixture, agents: [...fixture.agents, ...extras] };
}

function readRenderer(raw: string | null): StoryRenderer {
	return STORY_RENDERERS.find((renderer) => renderer === raw) ?? "channels";
}

/**
 * Stand-in for the desktop's real conversation surface (ChatPage). The real
 * host passes its chat page here; the story only needs something legible that
 * proves the renderer placed the host's view where a thread belongs.
 */
function StubThreadView({
	snapshot,
	threadId,
}: {
	snapshot: InterfaceSnapshot;
	threadId: string;
}) {
	const open = snapshot.threads.find((item) => item.id === threadId);
	const author =
		snapshot.agents.find((agent) => agent.id === open?.agentIds[0])?.name ??
		"Agent";
	return (
		<section
			aria-label="Conversation"
			className="flex size-full flex-col gap-3 overflow-y-auto bg-background p-4"
			data-testid="stub-thread-view"
		>
			<p className="self-center rounded-full border border-border border-dashed px-3 py-1 text-muted-foreground text-xs">
				Host chat surface (story stub) · {threadId}
			</p>
			<article className="max-w-[80%] self-end rounded-2xl bg-primary px-3 py-2 text-primary-foreground text-sm">
				{open?.title ?? "New conversation"}
			</article>
			<article className="flex max-w-[85%] flex-col gap-1 self-start rounded-2xl bg-muted px-3 py-2 text-sm">
				<span className="font-medium text-xs">{author}</span>
				<span>{open?.lastMessage ?? "On it."}</span>
			</article>
			{open?.running ? (
				<p className="self-start text-emerald-600 text-xs dark:text-emerald-400">
					{author} is working…
				</p>
			) : null}
		</section>
	);
}

/** `&fixture=useful` and its variants, from the query string. */
function usefulSnapshot(params: URLSearchParams): InterfaceSnapshot {
	const raw = (params.get("agents") ?? "").trim();
	// A bare number keeps the story's old meaning: the first N agents.
	const agents = /^\d+$/.test(raw)
		? Object.values(FIXTURE_AGENT_IDS).slice(0, Number(raw))
		: raw
				.split(",")
				.map((id) => id.trim())
				.filter(Boolean);
	const snapshot = usefulStateFixture({
		agents: agents.length > 0 ? agents : undefined,
		livePermission: params.get("livePermission") === "1",
		nowMs: FIXTURE_NOW,
		privacy: params.get("privacy") === "redacted" ? "redacted" : "full",
	});
	return params.get("noAsks") === "1" ? oldHostSnapshot(snapshot) : snapshot;
}

/** The same snapshot as a host without the act layer would send it. */
function oldHostSnapshot(snapshot: InterfaceSnapshot): InterfaceSnapshot {
	const {
		askBlindSpots: _blind,
		asks: _asks,
		observedAt: _observed,
		privacy: _privacy,
		...rest
	} = snapshot;
	return {
		...rest,
		agents: snapshot.agents.map(
			({ focusThreadId: _focus, limit: _limit, model: _model, ...agent }) =>
				agent
		),
		events: snapshot.events?.map(
			({
				error: _error,
				jobId: _job,
				requiresApproval: _approval,
				threadId: _thread,
				...event
			}) => event
		),
		threads: snapshot.threads.map(
			({
				activity: _activity,
				awaitingInput: _awaiting,
				blocker: _blocker,
				detail: _detail,
				helpers: _helpers,
				lastMessageAt: _lastAt,
				lastProgressAt: _progressAt,
				outcome: _outcome,
				progress: _progress,
				routineRun: _routine,
				runEndedAt: _ended,
				runStartedApprox: _approx,
				runStartedAt: _started,
				unread: _unread,
				workspace: _workspace,
				...thread
			}) => thread
		),
	};
}

const USEFUL =
	new URLSearchParams(window.location.search).get("fixture") === "useful";

function StoryHost({
	demo,
	initialThreadId,
	rawParams,
	renderer,
}: {
	demo: boolean;
	initialThreadId: string | null;
	rawParams: Record<string, string>;
	renderer: StoryRenderer;
}) {
	const [baseSnapshot, setSnapshot] = useState(() =>
		USEFUL
			? usefulSnapshot(search)
			: withAgentCount(FIXTURE, Number(search.get("agents") ?? Number.NaN))
	);
	const demoTick = useDemoTick(demo);
	const snapshot = useMemo(
		() => (demo ? demoSnapshot(baseSnapshot, demoTick) : baseSnapshot),
		[baseSnapshot, demo, demoTick]
	);
	const [activeThreadId, setActiveThreadId] = useState<string | null>(
		initialThreadId
	);
	const [portLog, setPortLog] = useState<string[]>([]);
	const record = useCallback((entry: string) => {
		setPortLog((previous) => [...previous.slice(-7), entry]);
	}, []);

	const port = useMemo<InterfacePort>(
		() => ({
			answerAsk: async (askId, choiceId) => {
				record(`answerAsk(${askId}, ${choiceId})`);
				setSnapshot((previous) => ({
					...previous,
					asks: previous.asks?.filter((ask) => ask.id !== askId),
				}));
			},
			openInbox: () => {
				record("openInbox()");
			},
			closeThread: () => {
				record("closeThread()");
				setActiveThreadId(null);
			},
			openThread: (threadId) => {
				record(`openThread(${threadId})`);
				setActiveThreadId(threadId);
			},
			startThread: ({ agentId, projectId, prompt, teamId }) => {
				record(
					`startThread(${JSON.stringify({ agentId, projectId, prompt, teamId })})`
				);
				if (!prompt) {
					return;
				}
				const id = `thread-new-${Date.now()}`;
				const created: InterfaceThread = {
					agentIds: agentId ? [agentId] : [],
					id,
					lastMessage: prompt,
					lastMessageRole: "user",
					messageCount: 1,
					pinned: false,
					projectId: projectId ?? null,
					running: true,
					teamId: teamId ?? null,
					title: prompt,
					updatedAt: new Date().toISOString(),
				};
				setSnapshot((previous) => ({
					...previous,
					threads: [created, ...previous.threads],
				}));
				setActiveThreadId(id);
			},
		}),
		[record]
	);

	const threadView: ReactNode | null = activeThreadId ? (
		<StubThreadView snapshot={snapshot} threadId={activeThreadId} />
	) : null;
	const shared = {
		activeThreadId,
		loading: false,
		port,
		snapshot,
		threadView,
	};

	let surface: ReactNode;
	switch (renderer) {
		case "channels":
			surface = (
				<ChannelsInterface
					{...shared}
					params={resolveInterfaceParams("channels", {
						groupBy: "project",
						...rawParams,
					})}
				/>
			);
			break;
		case "feed":
			surface = (
				<FeedInterface
					{...shared}
					params={resolveInterfaceParams("feed", rawParams)}
				/>
			);
			break;
		case "world-2d":
			surface = (
				<World2dInterface
					{...shared}
					params={resolveInterfaceParams("world-2d", rawParams)}
				/>
			);
			break;
		case "world-3d":
			surface = (
				<World3dInterface
					{...shared}
					params={resolveInterfaceParams("world-3d", rawParams)}
				/>
			);
			break;
		case "board":
			surface = (
				<BoardInterface
					{...shared}
					params={resolveInterfaceParams("board", rawParams)}
				/>
			);
			break;
		case "inbox":
			surface = <InboxInterface {...shared} params={{}} />;
			break;
		case "graph":
			surface = <GraphInterface {...shared} params={{}} />;
			break;
		case "timeline":
			surface = (
				<TimelineInterface
					{...shared}
					params={resolveInterfaceParams("timeline", rawParams)}
				/>
			);
			break;
		case "messenger":
			surface = <MessengerInterface {...shared} params={{}} />;
			break;
		case "terminal":
			surface = <TerminalInterface {...shared} params={{}} />;
			break;
		case "arena":
			surface = <ArenaInterface {...shared} params={{}} />;
			break;
		case "card-table":
			surface = (
				<CardTableInterface
					{...shared}
					params={resolveInterfaceParams("card-table", rawParams)}
				/>
			);
			break;
		case "sheet":
			surface = <SheetInterface {...shared} params={{}} />;
			break;
		case "canvas":
			surface = (
				<CanvasInterface
					{...shared}
					params={resolveInterfaceParams("canvas", rawParams)}
				/>
			);
			break;
		case "calendar":
			surface = (
				<CalendarInterface
					{...shared}
					params={resolveInterfaceParams("calendar", rawParams)}
				/>
			);
			break;
		case "notebook":
			surface = <NotebookInterface {...shared} params={{}} />;
			break;
		case "mission-control":
			surface = <MissionControlInterface {...shared} params={{}} />;
			break;
		case "ticker":
			surface = <TickerInterface {...shared} params={{}} />;
			break;
		case "focus":
			surface = <FocusInterface {...shared} params={{}} />;
			break;
		case "aquarium":
			surface = <AquariumInterface {...shared} params={{}} />;
			break;
		case "planets":
			surface = <PlanetsInterface {...shared} params={{}} />;
			break;
		case "stream":
			surface = <StreamInterface {...shared} params={{}} />;
			break;
		case "forum":
			surface = <ForumInterface {...shared} params={{}} />;
			break;
		case "live":
			surface = <LiveInterface {...shared} params={{}} />;
			break;
		case "posts":
			surface = <PostsInterface {...shared} params={{}} />;
			break;
		case "community":
			surface = <CommunityInterface {...shared} params={{}} />;
			break;
		case "wiki":
			surface = <WikiInterface {...shared} params={{}} />;
			break;
		case "dashboard":
			surface = <DashboardInterface {...shared} params={{}} />;
			break;
		case "mindmap":
			surface = <MindmapInterface {...shared} params={{}} />;
			break;
		case "gallery":
			surface = <GalleryInterface {...shared} params={{}} />;
			break;
		case "newspaper":
			surface = <NewspaperInterface {...shared} params={{}} />;
			break;
		case "qa":
			surface = <QaInterface {...shared} params={{}} />;
			break;
		case "cinema":
			surface = <CinemaInterface {...shared} params={{}} />;
			break;
		case "noticeboard":
			surface = <NoticeboardInterface {...shared} params={{}} />;
			break;
		case "mail":
			surface = <MailInterface {...shared} params={{}} />;
			break;
		case "status":
			surface = <StatusInterface {...shared} params={{}} />;
			break;
		case "records":
			surface = <RecordsInterface {...shared} params={{}} />;
			break;
		case "path":
			surface = <PathInterface {...shared} params={{}} />;
			break;
		case "glance":
			surface = <GlanceInterface {...shared} params={{}} />;
			break;
		case "hub":
			surface = <HubInterface {...shared} params={{}} />;
			break;
		case "library":
			surface = <LibraryInterface {...shared} params={{}} />;
			break;
		case "tickets":
			surface = <TicketsInterface {...shared} params={{}} />;
			break;
		case "persona":
			surface = <PersonaInterface {...shared} params={{}} />;
			break;
		case "panels":
			surface = <PanelsInterface {...shared} params={{}} />;
			break;
		case "departures":
			surface = <DeparturesInterface {...shared} params={{}} />;
			break;
		case "tracking":
			surface = <TrackingInterface {...shared} params={{}} />;
			break;
		case "flow":
			surface = <FlowInterface {...shared} params={{}} />;
			break;
		case "moments":
			surface = <MomentsInterface {...shared} params={{}} />;
			break;
		case "kitchen":
			surface = <KitchenInterface {...shared} params={{}} />;
			break;
		case "market":
			surface = <MarketInterface {...shared} params={{}} />;
			break;
		case "workers":
			surface = <WorkersInterface {...shared} params={{}} />;
			break;
		case "arcade":
			surface = <ArcadeInterface {...shared} params={{}} />;
			break;
		case "farm":
			surface = <FarmInterface {...shared} params={{}} />;
			break;
		case "town":
			surface = <TownInterface {...shared} params={{}} />;
			break;
		case "rides":
			surface = <RidesInterface {...shared} params={{}} />;
			break;
		case "journal":
			surface = <JournalInterface {...shared} params={{}} />;
			break;
		case "passport":
			surface = <PassportInterface {...shared} params={{}} />;
			break;
		case "lobby":
			surface = <LobbyInterface {...shared} params={{}} />;
			break;
		case "seasonal":
			surface = (
				<SeasonalInterface
					{...shared}
					params={resolveInterfaceParams("seasonal", rawParams)}
				/>
			);
			break;
		case "bank":
			surface = <BankInterface {...shared} params={{}} />;
			break;
		case "quiz":
			surface = <QuizInterface {...shared} params={{}} />;
			break;
		case "jobs":
			surface = <JobsInterface {...shared} params={{}} />;
			break;
		case "knowledge":
			surface = <KnowledgeInterface {...shared} params={{}} />;
			break;
		case "hologram":
			surface = <HologramInterface {...shared} params={{}} />;
			break;
		case "warehouse":
			surface = <WarehouseInterface {...shared} params={{}} />;
			break;
		default:
			surface = <DeskInterface {...shared} params={{}} />;
	}

	return (
		<main
			className="flex h-dvh w-dvw flex-col bg-background text-foreground"
			data-renderer={renderer}
			data-testid="interfaces-story"
		>
			<div className="min-h-0 flex-1">
				{CHROME ? (
					<InterfaceFrame
						canSwitchToConsole
						description={null}
						interfaceId={builtinInterfaceId(renderer)}
						label={renderer}
						onOpenPage={(path) => record(`openPage(${path})`)}
					>
						{surface}
					</InterfaceFrame>
				) : (
					surface
				)}
			</div>
			<output
				aria-label="Port calls"
				className="block shrink-0 truncate border-border border-t bg-muted/40 px-3 py-1 font-mono text-[11px] text-muted-foreground"
				data-testid="port-log"
			>
				{portLog.length > 0 ? portLog.join("  ·  ") : "port: idle"}
			</output>
		</main>
	);
}

/** The demo's fixture variants, one per phase (7 s each). */
const DEMO_PHASES: {
	label: string;
	nowMs: number;
	snapshot: () => InterfaceSnapshot;
}[] = [
	{
		label: "default",
		nowMs: FIXTURE_NOW,
		snapshot: () => usefulStateFixture(),
	},
	{
		label: "live permission",
		nowMs: FIXTURE_NOW,
		snapshot: () => usefulStateFixture({ livePermission: true }),
	},
	{
		// The same snapshot, 5.5 minutes later on the act clock only: Bo's
		// deadline stays put, so his ask enters its last 2 minutes.
		label: "Bo's ask about to expire",
		nowMs: FIXTURE_NOW + 5.5 * 60_000,
		snapshot: () => usefulStateFixture(),
	},
	{
		label: "redacted",
		nowMs: FIXTURE_NOW,
		snapshot: () => usefulStateFixture({ privacy: "redacted" }),
	},
];
const DEMO_PHASE_SECONDS = 7;

/** `?demo=life`: the act-layer demo island, moving through fixture variants. */
function DemoHost({ startPhase }: { startPhase: number }) {
	const [tick, setTick] = useState(startPhase);
	const [log, setLog] = useState<string[]>([]);
	useEffect(() => {
		// `&phase=N` or `&hold=1` holds one phase (for screenshots); without
		// either the demo moves through the phases.
		if (search.get("hold") === "1" || search.has("phase")) {
			return;
		}
		const timer = window.setInterval(
			() => setTick((value) => value + 1),
			DEMO_PHASE_SECONDS * 1000
		);
		return () => window.clearInterval(timer);
	}, []);
	const phase = DEMO_PHASES[tick % DEMO_PHASES.length] ?? DEMO_PHASES[0];
	const [answered, setAnswered] = useState<string[]>([]);
	const snapshot = useMemo(() => {
		const base = phase?.snapshot() ?? usefulStateFixture();
		return {
			...base,
			asks: base.asks?.filter((ask) => !answered.includes(ask.id)),
		};
	}, [answered, phase]);
	const port = useMemo<InterfacePort>(
		() => ({
			answerAsk: async (askId, choiceId) => {
				setLog((previous) => [
					...previous.slice(-3),
					`answerAsk(${askId}, ${choiceId})`,
				]);
				setAnswered((previous) => [...previous, askId]);
			},
			closeThread: () => undefined,
			openInbox: () =>
				setLog((previous) => [...previous.slice(-3), "openInbox()"]),
			openThread: (threadId) =>
				setLog((previous) => [
					...previous.slice(-3),
					`openThread(${threadId})`,
				]),
			startThread: () => undefined,
		}),
		[]
	);
	return (
		<ActClockProvider clock={FIXTURE_CLOCK} nowMs={phase?.nowMs ?? FIXTURE_NOW}>
			<div style={{ height: "100vh", position: "relative", width: "100vw" }}>
				<LifeDemo
					capacity={
						Number(search.get("capacity")) > 0
							? Number(search.get("capacity"))
							: Number.POSITIVE_INFINITY
					}
					port={port}
					snapshot={snapshot}
				/>
				<p
					className="pointer-events-none fixed right-2 bottom-2 z-50 rounded bg-black/60 px-2 py-1 font-mono text-[11px] text-white max-sm:hidden"
					data-testid="demo-log"
				>
					{`phase: ${phase?.label ?? ""}${log.length > 0 ? ` · ${log.at(-1)}` : ""}`}
				</p>
			</div>
		</ActClockProvider>
	);
}

const search = new URLSearchParams(window.location.search);
/**
 * `?chrome=1` draws the renderer inside the desktop's real host frame (the
 * top bar with the switcher, and the contained box), as InterfaceSurface
 * does, for the escape checks.
 */
const CHROME = search.get("chrome") === "1";
if (CHROME) {
	useProductModeStore.setState({
		consoleAccess: true,
		osAccess: true,
		requestedMode: "os",
	});
	useInterfaceStore.setState({
		workspaceInterfaceId: builtinInterfaceId(
			readRenderer(search.get("interface"))
		),
		workspaceInterfaces: true,
	});
}
const PARAM_KEYS = [
	"arrange",
	"camera",
	"groupBy",
	"layout",
	"order",
	"scale",
	"season",
	"theme",
	"view",
] as const;
const rawParams: Record<string, string> = {};
for (const key of PARAM_KEYS) {
	const value = search.get(key);
	if (value) {
		rawParams[key] = value;
	}
}

// `?preset=<theme id>` applies one of the shipped color themes, the way the
// desktop applies the user's Appearance choice, so renderers can be checked
// against themes other than the default. A dark preset also sets `.dark`.
const preset = THEME_VARIANTS.find(
	(variant) => variant.id === search.get("preset")
);
if (preset) {
	applyVariant(preset);
	document.documentElement.classList.toggle("dark", preset.mode === "dark");
}

const root = document.getElementById("root");
if (root) {
	const demo = search.get("demo") === "life";
	const host = (
		<StoryHost
			demo={demo}
			initialThreadId={search.get("thread")}
			rawParams={rawParams}
			renderer={readRenderer(search.get("interface"))}
		/>
	);
	let app: ReactNode = host;
	if (demo && !search.get("interface")) {
		app = <DemoHost startPhase={Number(search.get("phase") ?? 0) || 0} />;
	} else if (USEFUL) {
		app = (
			<ActClockProvider clock={FIXTURE_CLOCK} nowMs={FIXTURE_NOW}>
				{host}
			</ActClockProvider>
		);
	}
	createRoot(root).render(app);
}
