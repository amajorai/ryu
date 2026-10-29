// Full-bleed host for a non-OS workspace interface (Channels, Feed, the 2D/3D
// worlds, and Marketplace interfaces that select one of those renderers).
//
// The renderers are pure presentation. This host owns the two halves of the
// Interface Protocol for the desktop:
//
//   - the read model: `useInterfaceSnapshot()` over the shared chat history,
//     agents, teams, and workspace projects;
//   - the write side: an `InterfacePort` over the tab system, so opening or
//     starting a thread goes through the same `openTab` path the sidebar and the
//     OS desktop use, and the open thread renders through the real `ChatPage`
//     (`RouteOutlet`) with the same providers the OS window adapter uses.
//
// No interface sends a message on its own: a prompt only reaches `startThread`
// when the user typed and submitted it in the interface's composer.

import { Alert02Icon, ArrowLeft01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	GameKitSettingsContext,
	HostReducedMotionContext,
} from "@ryu/blocks/desktop/interfaces/game3d-settings.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@ryu/ui/components/empty.tsx";
import { toast } from "@ryu/ui/components/sileo.tsx";
import {
	type InterfaceAsk,
	type InterfaceDescriptor,
	type InterfacePort,
	type InterfaceSettingValue,
	interfaceParamsWithOverrides,
	interfaceSettingsFor,
	settingValueFits,
} from "@ryuhq/protocol/interfaces";
import { MotionConfig } from "motion/react";
import {
	Component,
	type ErrorInfo,
	lazy,
	type ReactNode,
	Suspense,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import {
	CurrentTabIdProvider,
	IsActiveTabProvider,
	subscribeTabOpenRequests,
	type Tab,
	useTabsContext,
} from "@/src/contexts/TabsContext.tsx";
import { RouteOutlet } from "@/src/contributions/RouteOutlet.tsx";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { useApprovals } from "@/src/hooks/useApprovals.ts";
import { usePersistedToggle } from "@/src/hooks/usePersistedToggle.ts";
import { respondQuestion } from "@/src/lib/api/acp.ts";
import { toTarget } from "@/src/lib/api/client.ts";
import {
	APPEARANCE_DEFAULTS,
	APPEARANCE_KEYS,
} from "@/src/lib/appearance-settings.ts";
import { reportError } from "@/src/lib/crash.ts";
import {
	getLivePermission,
	getQuestionHolder,
} from "@/src/store/useInterfaceDetailStore.ts";
import { useWorkspaceStore } from "@/src/store/useWorkspaceStore.ts";
import { InterfaceFrame } from "./InterfaceFrame.tsx";
import { backToChat } from "./interface-switcher.ts";
import { interfaceCredit, isPendingInterface } from "./registry.ts";
import {
	RetainedChatTrees,
	RetainedThreadSlot,
} from "./retained-chat-trees.tsx";
import { MAX_INTERFACE_THREADS } from "./snapshot.ts";
import { isChatTabPath, resolveSurfaceRenderer } from "./surface-renderer.ts";
import { useInterfaceActive } from "./use-interface-active.ts";
import { useInterfaceSettings } from "./use-interface-settings.ts";
import { useInterfaceSnapshot } from "./use-interface-snapshot.ts";

// Every renderer loads on demand, so a session pays only for the interface it
// shows (Layout imports this host statically, so a static import here would
// ship every renderer, and World 2D's scene modules, to OS and Console users).
const ChannelsInterface = lazy(() =>
	import("@ryu/blocks/desktop/interfaces/channels-interface.tsx").then(
		(module) => ({ default: module.ChannelsInterface })
	)
);
const FeedInterface = lazy(() =>
	import("@ryu/blocks/desktop/interfaces/feed-interface.tsx").then(
		(module) => ({ default: module.FeedInterface })
	)
);
const World2dInterface = lazy(() =>
	import("@ryu/blocks/desktop/interfaces/world-2d-interface.tsx").then(
		(module) => ({ default: module.World2dInterface })
	)
);

// three.js and react-three-fiber are heavy; only the 3D world pays for them.
const World3dInterface = lazy(() =>
	import("@ryu/blocks/desktop/interfaces/world-3d-interface.tsx").then(
		(module) => ({ default: module.World3dInterface })
	)
);

// The layout interfaces load on demand so the shell only ships the one in use
// (Graph pulls in the flow-graph library).
const BoardInterface = lazy(() =>
	import("@ryu/blocks/desktop/interfaces/board-interface.tsx").then(
		(module) => ({ default: module.BoardInterface })
	)
);
const InboxInterface = lazy(() =>
	import("@ryu/blocks/desktop/interfaces/inbox-interface.tsx").then(
		(module) => ({ default: module.InboxInterface })
	)
);
const GraphInterface = lazy(() =>
	import("@ryu/blocks/desktop/interfaces/graph-interface.tsx").then(
		(module) => ({ default: module.GraphInterface })
	)
);
const TimelineInterface = lazy(() =>
	import("@ryu/blocks/desktop/interfaces/timeline-interface.tsx").then(
		(module) => ({ default: module.TimelineInterface })
	)
);
const MessengerInterface = lazy(() =>
	import("@ryu/blocks/desktop/interfaces/messenger-interface.tsx").then(
		(module) => ({ default: module.MessengerInterface })
	)
);
const TerminalInterface = lazy(() =>
	import("@ryu/blocks/desktop/interfaces/terminal-interface.tsx").then(
		(module) => ({ default: module.TerminalInterface })
	)
);
const ArenaInterface = lazy(() =>
	import("@ryu/blocks/desktop/interfaces/arena-interface.tsx").then(
		(module) => ({ default: module.ArenaInterface })
	)
);

const DeskInterface = lazy(() =>
	import("@ryu/blocks/desktop/interfaces/desk-interface.tsx").then(
		(module) => ({ default: module.DeskInterface })
	)
);

const CardTableInterface = lazy(() =>
	import("@ryu/blocks/desktop/interfaces/card-table-interface.tsx").then(
		(module) => ({ default: module.CardTableInterface })
	)
);
const SheetInterface = lazy(() =>
	import("@ryu/blocks/desktop/interfaces/sheet-interface.tsx").then(
		(module) => ({ default: module.SheetInterface })
	)
);
const CanvasInterface = lazy(() =>
	import("@ryu/blocks/desktop/interfaces/canvas-interface.tsx").then(
		(module) => ({ default: module.CanvasInterface })
	)
);
const CalendarInterface = lazy(() =>
	import("@ryu/blocks/desktop/interfaces/calendar-interface.tsx").then(
		(module) => ({ default: module.CalendarInterface })
	)
);
const NotebookInterface = lazy(() =>
	import("@ryu/blocks/desktop/interfaces/notebook-interface.tsx").then(
		(module) => ({ default: module.NotebookInterface })
	)
);
const MissionControlInterface = lazy(() =>
	import("@ryu/blocks/desktop/interfaces/mission-control-interface.tsx").then(
		(module) => ({ default: module.MissionControlInterface })
	)
);
const TickerInterface = lazy(() =>
	import("@ryu/blocks/desktop/interfaces/ticker-interface.tsx").then(
		(module) => ({ default: module.TickerInterface })
	)
);
const FocusInterface = lazy(() =>
	import("@ryu/blocks/desktop/interfaces/focus-interface.tsx").then(
		(module) => ({ default: module.FocusInterface })
	)
);
const AquariumInterface = lazy(() =>
	import("@ryu/blocks/desktop/interfaces/aquarium-interface.tsx").then(
		(module) => ({ default: module.AquariumInterface })
	)
);

const PlanetsInterface = lazy(() =>
	import("@ryu/blocks/desktop/interfaces/planets-interface.tsx").then(
		(module) => ({ default: module.PlanetsInterface })
	)
);

const StreamInterface = lazy(() =>
	import("@ryu/blocks/desktop/interfaces/stream-interface.tsx").then(
		(module) => ({ default: module.StreamInterface })
	)
);
const ForumInterface = lazy(() =>
	import("@ryu/blocks/desktop/interfaces/forum-interface.tsx").then(
		(module) => ({ default: module.ForumInterface })
	)
);

const LiveInterface = lazy(() =>
	import("@ryu/blocks/desktop/interfaces/live-interface.tsx").then(
		(module) => ({ default: module.LiveInterface })
	)
);

const PostsInterface = lazy(() =>
	import("@ryu/blocks/desktop/interfaces/posts-interface.tsx").then(
		(module) => ({ default: module.PostsInterface })
	)
);
const CommunityInterface = lazy(() =>
	import("@ryu/blocks/desktop/interfaces/community-interface.tsx").then(
		(module) => ({ default: module.CommunityInterface })
	)
);
const WikiInterface = lazy(() =>
	import("@ryu/blocks/desktop/interfaces/wiki-interface.tsx").then(
		(module) => ({ default: module.WikiInterface })
	)
);
const DashboardInterface = lazy(() =>
	import("@ryu/blocks/desktop/interfaces/dashboard-interface.tsx").then(
		(module) => ({ default: module.DashboardInterface })
	)
);
const MindmapInterface = lazy(() =>
	import("@ryu/blocks/desktop/interfaces/mindmap-interface.tsx").then(
		(module) => ({ default: module.MindmapInterface })
	)
);
const GalleryInterface = lazy(() =>
	import("@ryu/blocks/desktop/interfaces/gallery-interface.tsx").then(
		(module) => ({ default: module.GalleryInterface })
	)
);
const NewspaperInterface = lazy(() =>
	import("@ryu/blocks/desktop/interfaces/newspaper-interface.tsx").then(
		(module) => ({ default: module.NewspaperInterface })
	)
);

const QaInterface = lazy(() =>
	import("@ryu/blocks/desktop/interfaces/qa-interface.tsx").then((module) => ({
		default: module.QaInterface,
	}))
);
const CinemaInterface = lazy(() =>
	import("@ryu/blocks/desktop/interfaces/cinema-interface.tsx").then(
		(module) => ({ default: module.CinemaInterface })
	)
);
const NoticeboardInterface = lazy(() =>
	import("@ryu/blocks/desktop/interfaces/noticeboard-interface.tsx").then(
		(module) => ({ default: module.NoticeboardInterface })
	)
);

const MailInterface = lazy(() =>
	import("@ryu/blocks/desktop/interfaces/mail-interface.tsx").then(
		(module) => ({ default: module.MailInterface })
	)
);
const StatusInterface = lazy(() =>
	import("@ryu/blocks/desktop/interfaces/status-interface.tsx").then(
		(module) => ({ default: module.StatusInterface })
	)
);
const RecordsInterface = lazy(() =>
	import("@ryu/blocks/desktop/interfaces/records-interface.tsx").then(
		(module) => ({ default: module.RecordsInterface })
	)
);

const PathInterface = lazy(() =>
	import("@ryu/blocks/desktop/interfaces/path-interface.tsx").then(
		(module) => ({ default: module.PathInterface })
	)
);
const GlanceInterface = lazy(() =>
	import("@ryu/blocks/desktop/interfaces/glance-interface.tsx").then(
		(module) => ({ default: module.GlanceInterface })
	)
);
const HubInterface = lazy(() =>
	import("@ryu/blocks/desktop/interfaces/hub-interface.tsx").then((module) => ({
		default: module.HubInterface,
	}))
);

const LibraryInterface = lazy(() =>
	import("@ryu/blocks/desktop/interfaces/library-interface.tsx").then(
		(module) => ({ default: module.LibraryInterface })
	)
);

const TicketsInterface = lazy(() =>
	import("@ryu/blocks/desktop/interfaces/tickets-interface.tsx").then(
		(module) => ({ default: module.TicketsInterface })
	)
);

const PersonaInterface = lazy(() =>
	import("@ryu/blocks/desktop/interfaces/persona-interface.tsx").then(
		(module) => ({ default: module.PersonaInterface })
	)
);
const PanelsInterface = lazy(() =>
	import("@ryu/blocks/desktop/interfaces/panels-interface.tsx").then(
		(module) => ({ default: module.PanelsInterface })
	)
);
const DeparturesInterface = lazy(() =>
	import("@ryu/blocks/desktop/interfaces/departures-interface.tsx").then(
		(module) => ({ default: module.DeparturesInterface })
	)
);
const TrackingInterface = lazy(() =>
	import("@ryu/blocks/desktop/interfaces/tracking-interface.tsx").then(
		(module) => ({ default: module.TrackingInterface })
	)
);
const FlowInterface = lazy(() =>
	import("@ryu/blocks/desktop/interfaces/flow-interface.tsx").then(
		(module) => ({ default: module.FlowInterface })
	)
);
const MomentsInterface = lazy(() =>
	import("@ryu/blocks/desktop/interfaces/moments-interface.tsx").then(
		(module) => ({ default: module.MomentsInterface })
	)
);
const KitchenInterface = lazy(() =>
	import("@ryu/blocks/desktop/interfaces/kitchen-interface.tsx").then(
		(module) => ({ default: module.KitchenInterface })
	)
);
const MarketInterface = lazy(() =>
	import("@ryu/blocks/desktop/interfaces/market-interface.tsx").then(
		(module) => ({ default: module.MarketInterface })
	)
);
const WorkersInterface = lazy(() =>
	import("@ryu/blocks/desktop/interfaces/workers-interface.tsx").then(
		(module) => ({ default: module.WorkersInterface })
	)
);

const ArcadeInterface = lazy(() =>
	import("@ryu/blocks/desktop/interfaces/arcade-interface.tsx").then(
		(module) => ({ default: module.ArcadeInterface })
	)
);
const FarmInterface = lazy(() =>
	import("@ryu/blocks/desktop/interfaces/farm-interface.tsx").then(
		(module) => ({ default: module.FarmInterface })
	)
);
const TownInterface = lazy(() =>
	import("@ryu/blocks/desktop/interfaces/town-interface.tsx").then(
		(module) => ({ default: module.TownInterface })
	)
);
const RidesInterface = lazy(() =>
	import("@ryu/blocks/desktop/interfaces/rides-interface.tsx").then(
		(module) => ({ default: module.RidesInterface })
	)
);
const JournalInterface = lazy(() =>
	import("@ryu/blocks/desktop/interfaces/journal-interface.tsx").then(
		(module) => ({ default: module.JournalInterface })
	)
);
const PassportInterface = lazy(() =>
	import("@ryu/blocks/desktop/interfaces/passport-interface.tsx").then(
		(module) => ({ default: module.PassportInterface })
	)
);
const LobbyInterface = lazy(() =>
	import("@ryu/blocks/desktop/interfaces/lobby-interface.tsx").then(
		(module) => ({ default: module.LobbyInterface })
	)
);
const SeasonalInterface = lazy(() =>
	import("@ryu/blocks/desktop/interfaces/seasonal-interface.tsx").then(
		(module) => ({ default: module.SeasonalInterface })
	)
);
const BankInterface = lazy(() =>
	import("@ryu/blocks/desktop/interfaces/bank-interface.tsx").then(
		(module) => ({ default: module.BankInterface })
	)
);
const QuizInterface = lazy(() =>
	import("@ryu/blocks/desktop/interfaces/quiz-interface.tsx").then(
		(module) => ({ default: module.QuizInterface })
	)
);
const JobsInterface = lazy(() =>
	import("@ryu/blocks/desktop/interfaces/jobs-interface.tsx").then(
		(module) => ({ default: module.JobsInterface })
	)
);
const KnowledgeInterface = lazy(() =>
	import("@ryu/blocks/desktop/interfaces/knowledge-interface.tsx").then(
		(module) => ({ default: module.KnowledgeInterface })
	)
);
const HologramInterface = lazy(() =>
	import("@ryu/blocks/desktop/interfaces/hologram-interface.tsx").then(
		(module) => ({ default: module.HologramInterface })
	)
);
const WarehouseInterface = lazy(() =>
	import("@ryu/blocks/desktop/interfaces/warehouse-interface.tsx").then(
		(module) => ({ default: module.WarehouseInterface })
	)
);

/**
 * Renderers that show the usage account, so only they read the wallet: Bank's
 * ledger and Town's HUD funds readout.
 */
const ACCOUNT_RENDERERS: ReadonlySet<string> = new Set(["bank", "town"]);

/**
 * Renderers that show scheduled runs, so only they make Core list schedules.
 * `interface-data-sets.test.ts` fails when a renderer reads `snapshot.events`
 * without being listed here.
 */
export const EVENT_RENDERERS: ReadonlySet<string> = new Set([
	"aquarium",
	"arcade",
	"arena",
	"calendar",
	"card-table",
	"dashboard",
	"departures",
	"farm",
	"flow",
	"glance",
	"hologram",
	"hub",
	"journal",
	"kitchen",
	"live",
	"lobby",
	"market",
	"mission-control",
	"newspaper",
	"notebook",
	"panels",
	"passport",
	"path",
	"persona",
	"planets",
	"quiz",
	"records",
	"rides",
	"seasonal",
	"status",
	"ticker",
	"town",
	"tracking",
	"warehouse",
	"wiki",
	"workers",
	"world-2d",
	"world-3d",
]);

/**
 * Answer an ask in place for the shared ask card. Approvals go through the
 * pending-approvals hook; anything this host cannot answer in place opens its
 * thread (or the inbox) so the user answers there. Never sends a message.
 */
export interface AnswerAskDeps {
	approve: (id: string) => Promise<unknown>;
	/** The ask as the latest snapshot holds it, or null once it is gone. */
	currentAsk: (askId: string) => InterfaceAsk | null;
	/** The respond callback a mounted chat tab on the active node published
	 *  for this ask's own thread; null when none holds it. */
	livePermission: (ask: InterfaceAsk) => ((optionId: string) => unknown) | null;
	openInbox: () => void;
	openThread: (threadId: string) => void;
	/** Where a Question card's answer posts: the conversation on the active
	 *  node holding this ask for its own thread; null when none (or more than
	 *  one) does. */
	questionHolder: (
		ask: InterfaceAsk
	) => { conversationId: string; toolCallId: string } | null;
	/** The latest snapshot is redacted: nothing is answered in place. */
	redacted: () => boolean;
	reject: (id: string) => Promise<unknown>;
	respondQuestion: (
		conversationId: string,
		toolCallId: string,
		answers: unknown[]
	) => Promise<{ resolved: boolean }>;
}

export async function answerAskWith(
	deps: AnswerAskDeps,
	askId: string,
	choiceId: string
): Promise<void> {
	const ask = deps.currentAsk(askId);
	if (!ask) {
		// Answered elsewhere or expired: the card shows "No longer waiting".
		return;
	}
	const openWhereItLives = () => {
		if (ask.threadId) {
			deps.openThread(ask.threadId);
		} else {
			deps.openInbox();
		}
	};
	if (deps.redacted()) {
		openWhereItLives();
		return;
	}
	if (askId.startsWith("approval:")) {
		const id = askId.slice("approval:".length);
		if (choiceId === "approve") {
			await deps.approve(id);
			return;
		}
		if (choiceId === "reject") {
			await deps.reject(id);
			return;
		}
	}
	if (askId.startsWith("question:")) {
		// The holder of the ask on screen (its thread, this node), never a
		// search: tool-call ids repeat across threads.
		const holder = deps.questionHolder(ask);
		if (!holder) {
			openWhereItLives();
			return;
		}
		let resolved = false;
		try {
			const result = await deps.respondQuestion(
				holder.conversationId,
				holder.toolCallId,
				[{ kind: "single", selectedIds: [choiceId] }]
			);
			resolved = result.resolved;
		} catch {
			resolved = false;
		}
		if (!resolved) {
			// No turn is waiting: answer in the thread's own card, never by a
			// synthetic message. The ask stays until the thread says otherwise.
			openWhereItLives();
		}
		return;
	}
	if (askId.startsWith("permission:")) {
		// The tab holding the ask on screen (its thread, this node), never a
		// search: `perm-<seq>` ids repeat across nodes and Core restarts.
		const respond = deps.livePermission(ask);
		if (respond) {
			await respond(choiceId);
			return;
		}
	}
	openWhereItLives();
}

/**
 * The one ask in a snapshot with this id. Two asks sharing an id (a tool-call
 * id repeated by two threads) cannot tell which card was tapped, so the
 * answer is refused and the card shows that it did not go through.
 */
export function snapshotAsk(
	asks: readonly InterfaceAsk[] | undefined,
	askId: string
): InterfaceAsk | null {
	const matches = (asks ?? []).filter((ask) => ask.id === askId);
	if (matches.length > 1) {
		throw new Error("More than one ask has this id");
	}
	return matches[0] ?? null;
}

interface InterfaceErrorBoundaryProps {
	children: ReactNode;
	label: string;
	/** Leave for the default chat (the escape every failure state offers). */
	onBackToChat: () => void;
	/** The renderer threw again after its retry: switch it off. */
	onGiveUp: () => void;
}

interface InterfaceErrorBoundaryState {
	failed: boolean;
}

/**
 * A renderer that throws is retried once (remounted); if it throws again the
 * host switches it off and returns to the default chat (`onGiveUp`). Until
 * then, and if that ever fails, the panel offers Back to chat.
 */
class InterfaceErrorBoundary extends Component<
	InterfaceErrorBoundaryProps,
	InterfaceErrorBoundaryState
> {
	state: InterfaceErrorBoundaryState = { failed: false };
	private failures = 0;

	static getDerivedStateFromError(): InterfaceErrorBoundaryState {
		return { failed: true };
	}

	componentDidCatch(error: Error, info: ErrorInfo) {
		reportError(error, {
			extra: { componentStack: info.componentStack ?? "" },
			tags: { surface: "interface" },
		});
		this.failures += 1;
		if (this.failures === 1) {
			// One retry: remount the renderer.
			this.setState({ failed: false });
			return;
		}
		this.props.onGiveUp();
	}

	render() {
		if (!this.state.failed) {
			return this.props.children;
		}
		return (
			<Empty className="size-full" data-testid="interface-error">
				<EmptyHeader>
					<EmptyMedia variant="icon">
						<HugeiconsIcon icon={Alert02Icon} />
					</EmptyMedia>
					<EmptyTitle>{this.props.label} could not be shown</EmptyTitle>
					<EmptyDescription>
						Your agents and threads are unaffected.
					</EmptyDescription>
				</EmptyHeader>
				<EmptyContent>
					<Button onClick={this.props.onBackToChat} type="button">
						Back to chat
					</Button>
				</EmptyContent>
			</Empty>
		);
	}
}

function headerDescription(descriptor: InterfaceDescriptor): string {
	const credit = interfaceCredit(descriptor);
	if (credit === null) {
		return descriptor.description;
	}
	return `${descriptor.description || descriptor.label} · ${credit}`;
}

/** Identity of what a tab shows: navigating it in place changes the key. */
function tabKey(tab: Tab | undefined): string {
	return tab ? `${tab.id}|${tab.path}|${tab.navToken ?? 0}` : "";
}

/** Primary folder of a workspace project, which `ChatPage` takes as its cwd. */
function projectFolder(projectId: string | undefined): string | undefined {
	if (!projectId) {
		return;
	}
	return useWorkspaceStore
		.getState()
		.projects.find((project) => project.id === projectId)?.folders[0];
}

/**
 * The interface's overview after the user left a tab: `closedId` is the tab
 * being closed, and `revealedKey` the tab that closing it revealed (null until
 * the close lands). Only that revealed tab stays hidden; any other navigation
 * (a deep link, a notification, a shortcut), including one that reopens the
 * revealed tab itself, shows normally.
 */
interface OverviewState {
	closedId: string;
	revealedKey: string | null;
}

/** Shown in place of a renderer when the conversation list could not be read,
 *  so a failed load never reads as an empty workspace. */
function SnapshotUnavailable({
	label,
	onRetry,
}: {
	label: string;
	onRetry: () => void;
}) {
	return (
		<Empty className="size-full" data-testid="interface-unavailable">
			<EmptyHeader>
				<EmptyMedia variant="icon">
					<HugeiconsIcon icon={Alert02Icon} />
				</EmptyMedia>
				<EmptyTitle>Couldn't load conversations</EmptyTitle>
				<EmptyDescription>
					{label} has nothing to show until your conversations load. Your agents
					and threads are unaffected.
				</EmptyDescription>
			</EmptyHeader>
			<EmptyContent>
				<Button onClick={onRetry} type="button">
					Retry
				</Button>
			</EmptyContent>
		</Empty>
	);
}

/** How long a renderer may take to mount before Back to chat is offered. */
export const SLOW_MOUNT_MS = 10_000;

/**
 * The placeholder while a renderer loads (its code, or a Marketplace
 * interface's plugin list). Past {@link SLOW_MOUNT_MS} it offers Back to chat,
 * so a renderer that never mounts cannot hold the window.
 */
function RendererFallback({
	label,
	onBackToChat,
}: {
	label: string;
	onBackToChat: () => void;
}) {
	const [slow, setSlow] = useState(false);
	useEffect(() => {
		const timer = window.setTimeout(() => setSlow(true), SLOW_MOUNT_MS);
		return () => window.clearTimeout(timer);
	}, []);
	if (!slow) {
		return (
			<div aria-busy="true" className="size-full bg-background" role="status">
				<span className="sr-only">Loading {label}</span>
			</div>
		);
	}
	return (
		<Empty className="size-full" data-testid="interface-slow">
			<EmptyHeader>
				<EmptyTitle>{label} is taking a while to open</EmptyTitle>
				<EmptyDescription>
					It may still appear. You can go back to the chat in the meantime.
				</EmptyDescription>
			</EmptyHeader>
			<EmptyContent>
				<Button onClick={onBackToChat} type="button">
					Back to chat
				</Button>
			</EmptyContent>
		</Empty>
	);
}

interface InterfaceSurfaceProps {
	canSwitchToConsole: boolean;
	descriptor: InterfaceDescriptor;
}

/** Renders the active workspace interface in place of the OS desktop. */
export function InterfaceSurface({
	canSwitchToConsole,
	descriptor,
}: InterfaceSurfaceProps) {
	const { activeTabId, closeTab, openTab, tabs } = useTabsContext();
	const setInterfaceActive = useInterfaceActive((state) => state.setActive);
	useEffect(() => {
		setInterfaceActive(true);
		return () => setInterfaceActive(false);
	}, [setInterfaceActive]);
	const { loading, omittedThreads, retry, snapshot, unavailable } =
		useInterfaceSnapshot({
			account: ACCOUNT_RENDERERS.has(descriptor.renderer),
			events: EVENT_RENDERERS.has(descriptor.renderer),
			live: true,
		});
	// The full-history list is never mounted here: same pending query as the snapshot.
	const { approve, reject } = useApprovals({ status: "pending" });
	const latestSnapshot = useRef(snapshot);
	latestSnapshot.current = snapshot;
	const decide = useRef({ approve, reject });
	decide.current = { approve, reject };
	const node = useActiveNode();
	const apiTarget = useRef(toTarget(node));
	apiTarget.current = toTarget(node);
	// The user's own settings for this interface, over its descriptor's params.
	const overrides = useInterfaceSettings(
		(state) => state.overrides[descriptor.id]
	);
	const resolved = useMemo(
		() =>
			resolveSurfaceRenderer({
				...descriptor,
				params: interfaceParamsWithOverrides(descriptor, overrides),
			}),
		[descriptor, overrides]
	);
	const latestDescriptor = useRef(descriptor);
	latestDescriptor.current = descriptor;
	// Every interface follows the app's Motion setting: animations off reads
	// as reduced motion, as the system preference does.
	const [animationsEnabled] = usePersistedToggle(
		APPEARANCE_KEYS.animationsEnabled,
		APPEARANCE_DEFAULTS.animationsEnabled
	);
	const kitParams = ("params" in resolved ? resolved.params : {}) as {
		overlayDensity?: "full" | "minimal";
		workBubbles?: boolean;
	};
	const kitSettings = useMemo(
		() => ({
			overlayDensity: kitParams.overlayDensity ?? "full",
			workBubbles: kitParams.workBubbles ?? true,
		}),
		[kitParams.overlayDensity, kitParams.workBubbles]
	);

	const activeTab = tabs.find((tab) => tab.id === activeTabId);
	const activeKey = tabKey(activeTab);

	// Closing a thread focuses a neighbouring tab, which may be another chat or
	// a page; the overview keeps that one revealed tab hidden until the user
	// navigates anywhere else. A page that was active when the interface
	// mounted (the OS home, an app) starts hidden the same way; an open chat
	// shows as the interface's thread.
	const [overview, setOverview] = useState<OverviewState | null>(() =>
		activeTab && !isChatTabPath(activeTab.path)
			? { closedId: "", revealedKey: activeKey }
			: null
	);
	useEffect(() => {
		setOverview((current) => {
			if (!current) {
				return current;
			}
			if (current.revealedKey === null) {
				// Still closing: wait until the closed tab is gone.
				return tabs.some((tab) => tab.id === current.closedId)
					? current
					: { ...current, revealedKey: activeKey };
			}
			return activeKey === current.revealedKey ? current : null;
		});
	}, [activeKey, tabs]);
	// Reopening the hidden tab (a deep link, a notification, or a shortcut to
	// the Settings page that is already active) changes no tab state, so the
	// effect above cannot tell it from staying put. Any explicit open request
	// is the user navigating, which ends the overview.
	useEffect(
		() =>
			subscribeTabOpenRequests(() => {
				setOverview(null);
			}),
		[]
	);

	const hidden =
		overview !== null &&
		(overview.revealedKey === null || overview.revealedKey === activeKey);
	const visibleTab: Tab | null =
		activeTab && !activeTab.unloaded && !hidden ? activeTab : null;
	const shownChatTab =
		visibleTab && isChatTabPath(visibleTab.path) ? visibleTab : null;
	// Anything else the user opened (Settings, the Marketplace, an app, a deep
	// link) shows as a page over the interface instead of disappearing.
	const shownPageTab = visibleTab && !shownChatTab ? visibleTab : null;

	// The port stays referentially stable for the renderers; this ref gives it
	// the latest tab state without re-creating it on every tab change.
	const latest = useRef(shownChatTab);
	latest.current = shownChatTab;

	const leaveTab = useCallback(
		(id: string) => {
			setOverview({ closedId: id, revealedKey: null });
			closeTab(id);
		},
		[closeTab]
	);

	const port = useMemo<InterfacePort>(() => {
		const openThread = (threadId: string) => {
			setOverview(null);
			// Reuses the tab already showing this conversation, if any.
			openTab("/chat", { conversationId: threadId });
		};
		const openInbox = () => {
			setOverview(null);
			openTab("/inbox");
		};
		return {
			answerAsk: (askId, choiceId) =>
				answerAskWith(
					{
						approve: (id) => decide.current.approve(id),
						livePermission: (ask) =>
							getLivePermission(ask, apiTarget.current.url)?.respond ?? null,
						openInbox,
						openThread,
						questionHolder: (ask) =>
							getQuestionHolder(ask, apiTarget.current.url),
						reject: (id) => decide.current.reject(id),
						respondQuestion: (conversationId, toolCallId, answers) =>
							respondQuestion(
								apiTarget.current,
								conversationId,
								toolCallId,
								answers
							),
						currentAsk: (id) => snapshotAsk(latestSnapshot.current.asks, id),
						redacted: () => latestSnapshot.current.privacy === "redacted",
					},
					askId,
					choiceId
				),
			closeThread: () => {
				const open = latest.current;
				if (open) {
					leaveTab(open.id);
				}
			},
			openInbox,
			openThread,
			startThread: ({ agentId, projectId, prompt, teamId }) => {
				setOverview(null);
				const typed = prompt?.trim() ? prompt : undefined;
				openTab("/chat", {
					forceNew: true,
					initialAgent: agentId,
					initialProject: projectFolder(projectId),
					initialPrompt: typed,
					// Only a prompt the user typed and submitted here is sent.
					initialSubmit: typed ? true : undefined,
					initialTeamId: teamId,
				});
			},
			updateSettings: (patch) => {
				// Only the settings this interface shows, with values that fit.
				const current = latestDescriptor.current;
				const fields = new Map(
					interfaceSettingsFor(current).map((field) => [field.key, field])
				);
				const kept: Record<string, InterfaceSettingValue> = {};
				for (const [key, value] of Object.entries(patch)) {
					const field = fields.get(key);
					if (field && settingValueFits(field, value)) {
						kept[key] = value;
					}
				}
				if (Object.keys(kept).length > 0) {
					useInterfaceSettings.getState().setSettings(current.id, kept);
				}
			},
			resetSettings: () => {
				useInterfaceSettings
					.getState()
					.resetSettings(latestDescriptor.current.id);
			},
		};
	}, [leaveTab, openTab]);

	const openPage = (path: string, title: string) => {
		setOverview(null);
		openTab(path, { title });
	};

	const pending = isPendingInterface(descriptor);
	const leaveForChat = () => backToChat(canSwitchToConsole);
	const label = descriptor.label || "Interface";

	// Every open chat tab stays mounted (in a hidden container) so switching
	// threads does not unmount the others and abort their resumed streams; the
	// shown one is moved into the renderer's thread slot.
	const retainedChatTabs = useMemo(
		() => tabs.filter((tab) => isChatTabPath(tab.path) && !tab.unloaded),
		[tabs]
	);
	const threadView = shownChatTab ? (
		<RetainedThreadSlot tabId={shownChatTab.id} />
	) : null;

	const common = {
		activeThreadId: shownChatTab?.conversationId ?? null,
		loading,
		port,
		snapshot,
		threadView,
	};

	// Lazily loaded layouts share the quiet loading fallback.
	const lazyLayout = (node: ReactNode) => (
		<Suspense
			fallback={
				<RendererFallback
					label={descriptor.label}
					onBackToChat={leaveForChat}
				/>
			}
		>
			{node}
		</Suspense>
	);
	let body: ReactNode;
	switch (resolved.renderer) {
		case "channels":
			body = lazyLayout(
				<ChannelsInterface {...common} params={resolved.params} />
			);
			break;
		case "feed":
			body = lazyLayout(<FeedInterface {...common} params={resolved.params} />);
			break;
		case "world-2d":
			body = lazyLayout(
				<World2dInterface {...common} params={resolved.params} />
			);
			break;
		case "world-3d":
			body = lazyLayout(
				<World3dInterface {...common} params={resolved.params} />
			);
			break;
		case "board":
			body = lazyLayout(
				<BoardInterface {...common} params={resolved.params} />
			);
			break;
		case "inbox":
			body = lazyLayout(
				<InboxInterface {...common} params={resolved.params} />
			);
			break;
		case "graph":
			body = lazyLayout(
				<GraphInterface {...common} params={resolved.params} />
			);
			break;
		case "timeline":
			body = lazyLayout(
				<TimelineInterface {...common} params={resolved.params} />
			);
			break;
		case "messenger":
			body = lazyLayout(
				<MessengerInterface {...common} params={resolved.params} />
			);
			break;
		case "terminal":
			body = lazyLayout(
				<TerminalInterface {...common} params={resolved.params} />
			);
			break;
		case "arena":
			body = lazyLayout(
				<ArenaInterface {...common} params={resolved.params} />
			);
			break;
		case "desk":
			body = lazyLayout(<DeskInterface {...common} params={resolved.params} />);
			break;
		case "card-table":
			body = lazyLayout(
				<CardTableInterface {...common} params={resolved.params} />
			);
			break;
		case "sheet":
			body = lazyLayout(
				<SheetInterface {...common} params={resolved.params} />
			);
			break;
		case "canvas":
			body = lazyLayout(
				<CanvasInterface {...common} params={resolved.params} />
			);
			break;
		case "calendar":
			body = lazyLayout(
				<CalendarInterface {...common} params={resolved.params} />
			);
			break;
		case "notebook":
			body = lazyLayout(
				<NotebookInterface {...common} params={resolved.params} />
			);
			break;
		case "mission-control":
			body = lazyLayout(
				<MissionControlInterface {...common} params={resolved.params} />
			);
			break;
		case "ticker":
			body = lazyLayout(
				<TickerInterface {...common} params={resolved.params} />
			);
			break;
		case "focus":
			body = lazyLayout(
				<FocusInterface {...common} params={resolved.params} />
			);
			break;
		case "aquarium":
			body = lazyLayout(
				<AquariumInterface {...common} params={resolved.params} />
			);
			break;
		case "planets":
			body = lazyLayout(
				<PlanetsInterface {...common} params={resolved.params} />
			);
			break;
		case "stream":
			body = lazyLayout(
				<StreamInterface {...common} params={resolved.params} />
			);
			break;
		case "forum":
			body = lazyLayout(
				<ForumInterface {...common} params={resolved.params} />
			);
			break;
		case "live":
			body = lazyLayout(<LiveInterface {...common} params={resolved.params} />);
			break;
		case "posts":
			body = lazyLayout(
				<PostsInterface {...common} params={resolved.params} />
			);
			break;
		case "community":
			body = lazyLayout(
				<CommunityInterface {...common} params={resolved.params} />
			);
			break;
		case "wiki":
			body = lazyLayout(<WikiInterface {...common} params={resolved.params} />);
			break;
		case "dashboard":
			body = lazyLayout(
				<DashboardInterface {...common} params={resolved.params} />
			);
			break;
		case "mindmap":
			body = lazyLayout(
				<MindmapInterface {...common} params={resolved.params} />
			);
			break;
		case "gallery":
			body = lazyLayout(
				<GalleryInterface {...common} params={resolved.params} />
			);
			break;
		case "newspaper":
			body = lazyLayout(
				<NewspaperInterface {...common} params={resolved.params} />
			);
			break;
		case "qa":
			body = lazyLayout(<QaInterface {...common} params={resolved.params} />);
			break;
		case "cinema":
			body = lazyLayout(
				<CinemaInterface {...common} params={resolved.params} />
			);
			break;
		case "noticeboard":
			body = lazyLayout(
				<NoticeboardInterface {...common} params={resolved.params} />
			);
			break;
		case "mail":
			body = lazyLayout(<MailInterface {...common} params={resolved.params} />);
			break;
		case "status":
			body = lazyLayout(
				<StatusInterface {...common} params={resolved.params} />
			);
			break;
		case "records":
			body = lazyLayout(
				<RecordsInterface {...common} params={resolved.params} />
			);
			break;
		case "path":
			body = lazyLayout(<PathInterface {...common} params={resolved.params} />);
			break;
		case "glance":
			body = lazyLayout(
				<GlanceInterface {...common} params={resolved.params} />
			);
			break;
		case "hub":
			body = lazyLayout(<HubInterface {...common} params={resolved.params} />);
			break;
		case "library":
			body = lazyLayout(
				<LibraryInterface {...common} params={resolved.params} />
			);
			break;
		case "tickets":
			body = lazyLayout(
				<TicketsInterface {...common} params={resolved.params} />
			);
			break;
		case "persona":
			body = lazyLayout(
				<PersonaInterface {...common} params={resolved.params} />
			);
			break;
		case "panels":
			body = lazyLayout(
				<PanelsInterface {...common} params={resolved.params} />
			);
			break;
		case "departures":
			body = lazyLayout(
				<DeparturesInterface {...common} params={resolved.params} />
			);
			break;
		case "tracking":
			body = lazyLayout(
				<TrackingInterface {...common} params={resolved.params} />
			);
			break;
		case "flow":
			body = lazyLayout(<FlowInterface {...common} params={resolved.params} />);
			break;
		case "moments":
			body = lazyLayout(
				<MomentsInterface {...common} params={resolved.params} />
			);
			break;
		case "kitchen":
			body = lazyLayout(
				<KitchenInterface {...common} params={resolved.params} />
			);
			break;
		case "market":
			body = lazyLayout(
				<MarketInterface {...common} params={resolved.params} />
			);
			break;
		case "workers":
			body = lazyLayout(
				<WorkersInterface {...common} params={resolved.params} />
			);
			break;
		case "arcade":
			body = lazyLayout(
				<ArcadeInterface {...common} params={resolved.params} />
			);
			break;
		case "farm":
			body = lazyLayout(<FarmInterface {...common} params={resolved.params} />);
			break;
		case "town":
			body = lazyLayout(<TownInterface {...common} params={resolved.params} />);
			break;
		case "rides":
			body = lazyLayout(
				<RidesInterface {...common} params={resolved.params} />
			);
			break;
		case "journal":
			body = lazyLayout(
				<JournalInterface {...common} params={resolved.params} />
			);
			break;
		case "passport":
			body = lazyLayout(
				<PassportInterface {...common} params={resolved.params} />
			);
			break;
		case "lobby":
			body = lazyLayout(
				<LobbyInterface {...common} params={resolved.params} />
			);
			break;
		case "seasonal":
			body = lazyLayout(
				<SeasonalInterface {...common} params={resolved.params} />
			);
			break;
		case "bank":
			body = lazyLayout(<BankInterface {...common} params={resolved.params} />);
			break;
		case "quiz":
			body = lazyLayout(<QuizInterface {...common} params={resolved.params} />);
			break;
		case "jobs":
			body = lazyLayout(<JobsInterface {...common} params={resolved.params} />);
			break;
		case "knowledge":
			body = lazyLayout(
				<KnowledgeInterface {...common} params={resolved.params} />
			);
			break;
		case "hologram":
			body = lazyLayout(
				<HologramInterface {...common} params={resolved.params} />
			);
			break;
		case "warehouse":
			body = lazyLayout(
				<WarehouseInterface {...common} params={resolved.params} />
			);
			break;
		default:
			body = null;
	}
	if (pending) {
		// A remembered Marketplace interface whose plugin list is still loading.
		body = <RendererFallback label={label} onBackToChat={leaveForChat} />;
	} else if (unavailable && !shownChatTab) {
		body = <SnapshotUnavailable label={label} onRetry={retry} />;
	}

	const pageOverlay = shownPageTab ? (
		<section
			aria-label={shownPageTab.title || "Page"}
			className="absolute inset-0 z-20 flex flex-col bg-background"
			data-testid="ryu-interface-page"
		>
			<div className="flex h-10 shrink-0 items-center gap-2 border-border border-b px-2">
				<Button
					onClick={() => leaveTab(shownPageTab.id)}
					size="sm"
					type="button"
					variant="ghost"
				>
					<HugeiconsIcon
						aria-hidden="true"
						data-icon="inline-start"
						icon={ArrowLeft01Icon}
					/>
					Back to {label}
				</Button>
				<span
					className="min-w-0 truncate text-muted-foreground text-sm"
					title={shownPageTab.title}
				>
					{shownPageTab.title}
				</span>
			</div>
			<IsActiveTabProvider
				isActive
				key={`${shownPageTab.id}:${shownPageTab.navToken ?? 0}`}
			>
				<CurrentTabIdProvider tabId={shownPageTab.id}>
					<div className="flex min-h-0 flex-1 flex-col overflow-hidden">
						<RouteOutlet
							onClose={() => leaveTab(shownPageTab.id)}
							tab={shownPageTab}
						/>
					</div>
				</CurrentTabIdProvider>
			</IsActiveTabProvider>
		</section>
	) : null;

	return (
		<InterfaceFrame
			canSwitchToConsole={canSwitchToConsole}
			description={pending ? null : headerDescription(descriptor)}
			interfaceId={descriptor.id}
			label={label}
			notice={
				omittedThreads > 0 ? (
					<p
						className="hidden shrink-0 text-muted-foreground text-xs md:block"
						data-testid="ryu-interface-omitted-threads"
					>
						{`Showing the ${MAX_INTERFACE_THREADS} most recent threads. ${omittedThreads} older ${omittedThreads === 1 ? "one is" : "ones are"} in Agent and search.`}
					</p>
				) : null
			}
			onOpenPage={openPage}
			overlay={pageOverlay}
		>
			{/* The interface stays mounted under a page (so its state survives)
			    but is inert there: no focus, clicks, or document-level
			    shortcuts reach it until the page closes. */}
			<div
				className="contents"
				data-testid="ryu-interface-body"
				inert={shownPageTab ? true : undefined}
			>
				<RetainedChatTrees
					renderTab={(tab) => (
						<RouteOutlet onClose={() => leaveTab(tab.id)} tab={tab} />
					)}
					shownTabId={shownChatTab?.id ?? null}
					tabs={retainedChatTabs}
				>
					<InterfaceErrorBoundary
						key={descriptor.id}
						label={label}
						onBackToChat={leaveForChat}
						onGiveUp={() => {
							toast.error(`${label} crashed and was switched off`);
							leaveForChat();
						}}
					>
						<HostReducedMotionContext.Provider value={!animationsEnabled}>
							{/* Plain motion components follow the app's Motion setting too;
							    the renderers' own hook reads the context above. */}
							<MotionConfig
								reducedMotion={animationsEnabled ? "user" : "always"}
							>
								<GameKitSettingsContext.Provider value={kitSettings}>
									{body}
								</GameKitSettingsContext.Provider>
							</MotionConfig>
						</HostReducedMotionContext.Provider>
					</InterfaceErrorBoundary>
				</RetainedChatTrees>
			</div>
		</InterfaceFrame>
	);
}
