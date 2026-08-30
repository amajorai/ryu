// Shown in the main content area whenever every tab is closed. Rather than a
// bare "no tabs" placeholder, this is a personalized launchpad: a greeting, a
// row of quick actions to start something new, and "jump back in" lists of the
// user's recent agents and spaces. It mounts only while the window has
// zero tabs (see Layout), so the data hooks it pulls (agents/spaces) only
// fetch in that idle state.

import { ArrowDown01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Logo as RyuLogo } from "@ryu/ui/components/logo";
import { StaggerReveal } from "@ryu/ui/components/stagger-reveal";
import { cn } from "@ryu/ui/lib/utils";
import {
	ArrowRight,
	Bot,
	Import,
	Layers,
	type LucideIcon,
	MessageSquarePlus,
	Settings2,
	Sparkles,
	Workflow,
} from "lucide-react";
import {
	type DragEvent,
	type ReactNode,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import type { PluginComposerControlRow } from "@/components/agent-elements/input/goal-plus-button.tsx";
import { useSession } from "@/lib/auth-client.ts";
import { useComposerSlot } from "@/src/components/assistant/useComposerSlot.tsx";
import { GettingStartedChecklist } from "@/src/components/chat/GettingStartedChecklist.tsx";
import { ImportSetupDialog } from "@/src/components/chat/ImportSetupDialog.tsx";
import { ImportThreadsDialog } from "@/src/components/chat/ImportThreadsDialog.tsx";
import { WorkspaceBar } from "@/src/components/chat/WorkspaceBar.tsx";
import { LiveActivityDock } from "@/src/components/live/LiveActivityDock.tsx";
import { useSpacesContext } from "@/src/contexts/SpacesContext.tsx";
import { useTabsContext } from "@/src/contexts/TabsContext.tsx";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { useAgents } from "@/src/hooks/useAgents.ts";
import { useEngineModels } from "@/src/hooks/useEngineModels.ts";
import { useGettingStarted } from "@/src/hooks/useGettingStarted.ts";
import { useInterfaceLevel } from "@/src/hooks/useInterfaceLevel.ts";
import { useNodeDefaultAgentId } from "@/src/hooks/useNodeDefaultAgent.ts";
import { usePluginContributions } from "@/src/hooks/usePluginContributions.ts";
import { useTeams } from "@/src/hooks/useTeams.ts";
import { AgentAvatar, engineForAgent } from "@/src/lib/agent-logos.tsx";
import { TEMPORARY_CONTEXT_FLAG } from "@/src/lib/api/temporary-chat.ts";
import {
	readLastUsedAgentId,
	rememberLastUsedAgent,
	seedComposerAgentId,
	shouldAdoptNodeDefault,
} from "@/src/lib/composer-target.ts";
import { normalizeTimestamp, stampRecent } from "@/src/lib/library.ts";
import {
	getAgentModel,
	modelsForAgent,
	setAgentModel,
} from "@/src/lib/models.ts";
import { useCreateAgentDialog } from "@/src/store/useCreateAgentDialog.ts";

/** How many items each "recent" list shows before linking out to "See all". */
const RECENT_LIMIT = 5;

/** Splits a name on whitespace to pull the first token for the greeting. */
const WHITESPACE_RE = /\s+/;

/** A greeting that tracks the time of day, so the home reads as alive. */
function greeting(): string {
	const hour = new Date().getHours();
	if (hour < 5) {
		return "Good evening";
	}
	if (hour < 12) {
		return "Good morning";
	}
	if (hour < 18) {
		return "Good afternoon";
	}
	return "Good evening";
}

/** First name only — a full name in a greeting reads stiff. */
function firstName(name: string | null | undefined): string | null {
	const trimmed = name?.trim();
	if (!trimmed) {
		return null;
	}
	return trimmed.split(WHITESPACE_RE)[0];
}

/** One normalized entry across the recent lists, so the row renderer is shared. */
interface RecentRow {
	id: string;
	/** Optional leading visual (e.g. an agent's engine logo), shown before the name. */
	leading?: ReactNode;
	name: string;
	open: () => void;
	subtitle: string | null;
}

interface QuickAction {
	description: string;
	icon: LucideIcon;
	label: string;
	onSelect: () => void;
	primary?: boolean;
}

function QuickActionCard({ action }: { action: QuickAction }) {
	const Icon = action.icon;
	return (
		<button
			className={cn(
				"group flex min-h-40 flex-col justify-between gap-4 overflow-hidden rounded-xl p-4 text-left backdrop-blur-sm transition-all duration-200",
				action.primary
					? "bg-primary/10 hover:bg-primary/15"
					: "bg-muted/50 hover:bg-muted/70"
			)}
			onClick={action.onSelect}
			type="button"
		>
			<Icon
				className={cn(
					"size-6 shrink-0",
					action.primary
						? "text-primary"
						: "text-muted-foreground group-hover:text-foreground"
				)}
			/>
			<span className="min-w-0">
				<span className="mb-1 block truncate font-medium text-foreground text-lg">
					{action.label}
				</span>
				<span className="block truncate text-muted-foreground text-sm">
					{action.description}
				</span>
			</span>
		</button>
	);
}

/** The reorderable launchpad sections, in their default order. */
type HomeSectionKey = "get-started" | "quick-actions" | "agents" | "spaces";
const DEFAULT_HOME_SECTION_ORDER: HomeSectionKey[] = [
	"get-started",
	"quick-actions",
	"agents",
	"spaces",
];
const HOME_SECTION_ORDER_KEY = "ryu:home-section-order";

function isHomeSectionKey(value: string): value is HomeSectionKey {
	return (DEFAULT_HOME_SECTION_ORDER as string[]).includes(value);
}

/** Loads the persisted order, reconciling any keys added since it was saved. */
function loadHomeSectionOrder(): HomeSectionKey[] {
	try {
		const stored = localStorage.getItem(HOME_SECTION_ORDER_KEY);
		if (!stored) {
			return [...DEFAULT_HOME_SECTION_ORDER];
		}
		const parsed = JSON.parse(stored) as string[];
		const order = [...new Set(parsed.filter(isHomeSectionKey))];
		// Reconcile keys added since the order was last saved: insert each missing
		// key at its default position (before the first saved key that follows it in
		// the default order) rather than blindly appending, so e.g. a new top
		// section lands at the top for existing users too.
		for (const key of DEFAULT_HOME_SECTION_ORDER) {
			if (order.includes(key)) {
				continue;
			}
			const defaultIdx = DEFAULT_HOME_SECTION_ORDER.indexOf(key);
			const insertAt = order.findIndex(
				(k) => DEFAULT_HOME_SECTION_ORDER.indexOf(k) > defaultIdx
			);
			if (insertAt === -1) {
				order.push(key);
			} else {
				order.splice(insertAt, 0, key);
			}
		}
		return order;
	} catch {
		return [...DEFAULT_HOME_SECTION_ORDER];
	}
}

function saveHomeSectionOrder(order: HomeSectionKey[]) {
	try {
		localStorage.setItem(HOME_SECTION_ORDER_KEY, JSON.stringify(order));
	} catch {
		// best-effort; ordering is a convenience, not critical state
	}
}

/** Drag-and-drop wiring threaded into every reorderable section header. */
interface HomeSectionDnd {
	draggingKey: HomeSectionKey | null;
	dragOverKey: HomeSectionKey | null;
	onDragEnd: () => void;
	onDragOver: (key: HomeSectionKey) => void;
	onDragStart: (key: HomeSectionKey) => void;
	onDrop: (key: HomeSectionKey) => void;
	/** Current order, so a target can tell which side to draw the drop line. */
	order: HomeSectionKey[];
}

/**
 * A collapsible, reorderable home section with a sidebar-style header. The
 * chevron and the optional "See all" action both reveal on hover; the header
 * doubles as a drag handle to reorder sections, mirroring the app sidebar.
 */
function HomeSection({
	title,
	sectionKey,
	dnd,
	onSeeAll,
	children,
}: {
	title: string;
	sectionKey?: HomeSectionKey;
	dnd?: HomeSectionDnd;
	onSeeAll?: () => void;
	children: ReactNode;
}) {
	const [collapsed, setCollapsed] = useState(false);
	// Reordering is opt-in: a section is draggable only when given both a key and
	// the shared dnd wiring (the transient onboarding section stays put).
	const reorderable = dnd !== undefined && sectionKey !== undefined;
	const isDragging = reorderable && dnd.draggingKey === sectionKey;
	const isDragOver =
		reorderable &&
		dnd.dragOverKey === sectionKey &&
		dnd.draggingKey !== null &&
		dnd.draggingKey !== sectionKey;
	// The drop inserts after the target when dragging downward, before it when
	// dragging upward — so draw the indicator line on the matching edge.
	const dropBelow =
		isDragOver &&
		dnd.draggingKey !== null &&
		dnd.order.indexOf(dnd.draggingKey) < dnd.order.indexOf(sectionKey);
	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: section is the drag-and-drop reorder target; the header button carries the keyboard-reachable affordance
		// biome-ignore lint/a11y/noNoninteractiveElementInteractions: section is the drag-and-drop reorder target; the header button carries the keyboard-reachable affordance
		<section
			className={cn(
				"group/section relative flex min-w-0 flex-col gap-2",
				isDragging && "opacity-50"
			)}
			onDragOver={(e) => {
				if (reorderable && dnd.draggingKey) {
					e.preventDefault();
					e.dataTransfer.dropEffect = "move";
					dnd.onDragOver(sectionKey);
				}
			}}
			onDrop={(e) => {
				if (reorderable) {
					e.preventDefault();
					dnd.onDrop(sectionKey);
				}
			}}
		>
			{isDragOver && (
				<div
					className={cn(
						"reorder-drop-indicator pointer-events-none absolute inset-x-1 z-10 h-0.5 bg-primary",
						dropBelow ? "bottom-0" : "top-0"
					)}
				/>
			)}
			<div className="flex items-center gap-2 px-1">
				<button
					className={cn(
						"group/hdr flex min-w-0 flex-1 items-center gap-1.5 rounded-md py-1 text-left font-medium text-muted-foreground text-xs transition-colors hover:text-foreground",
						reorderable && "cursor-grab active:cursor-grabbing"
					)}
					draggable={reorderable}
					onClick={() => setCollapsed((v) => !v)}
					onDragEnd={reorderable ? () => dnd.onDragEnd() : undefined}
					onDragStart={
						reorderable
							? (e) => {
									e.dataTransfer.effectAllowed = "move";
									e.dataTransfer.setData("text/plain", sectionKey);
									dnd.onDragStart(sectionKey);
								}
							: undefined
					}
					type="button"
				>
					<span className="min-w-0 truncate">{title}</span>
					<HugeiconsIcon
						className={cn(
							"size-3 shrink-0 opacity-0 transition group-hover/hdr:opacity-100",
							collapsed && "-rotate-90"
						)}
						icon={ArrowDown01Icon}
					/>
				</button>
				{onSeeAll && (
					<button
						className="flex shrink-0 items-center gap-0.5 text-muted-foreground text-xs opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover/section:opacity-100"
						onClick={onSeeAll}
						type="button"
					>
						See all
						<ArrowRight className="size-3" />
					</button>
				)}
			</div>
			{!collapsed && children}
		</section>
	);
}

/** The body of a recent list: either the rows, or a dashed empty hint. */
function RecentList({
	rows,
	emptyHint,
}: {
	rows: RecentRow[];
	emptyHint: string;
}) {
	if (rows.length === 0) {
		return (
			<p className="rounded-xl border border-border border-dashed px-3 py-4 text-center text-muted-foreground text-xs">
				{emptyHint}
			</p>
		);
	}
	return (
		<ul className="flex flex-col gap-0.5">
			{rows.map((row) => (
				<li key={row.id}>
					<button
						className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left transition-colors hover:bg-muted"
						onClick={row.open}
						type="button"
					>
						{row.leading}
						<span className="flex min-w-0 flex-col gap-0.5">
							<span className="truncate font-medium text-foreground text-sm">
								{row.name}
							</span>
							{row.subtitle && (
								<span className="truncate text-muted-foreground text-xs">
									{row.subtitle}
								</span>
							)}
						</span>
					</button>
				</li>
			))}
		</ul>
	);
}

/**
 * The real chat composer, surfaced on the launchpad — literally the same composer
 * the Ask Ryu dock and the builder panes render, built by the one shared
 * `useComposerSlot`: agent/model/thinking pickers, the "+" dropdown, staged image
 * attachments, live voice input (STT), and voice mode. It used to re-wire those
 * pieces itself, which is exactly how the "+" here silently stayed a bare file
 * dialog while the chat page's grew a dropdown. Sending opens a fresh chat tab
 * seeded with the typed text, the chosen agent, the temporary-chat pick, and any
 * staged images (which have no conversation to live on yet, so they ride the tab
 * seed into the new chat). The model pick is persisted per-agent
 * (`setAgentModel`), so the new chat surfaces the same agent/model.
 */
function LaunchpadComposer() {
	const { openTab } = useTabsContext();
	const { openCreateAgent } = useCreateAgentDialog();
	const { agents } = useAgents();
	const { teams } = useTeams();
	const engineModels = useEngineModels();
	const activeNode = useActiveNode();
	const interfaceLevel = useInterfaceLevel();
	const pluginContributions = usePluginContributions();

	// The launchpad is always a BRAND NEW chat, so it runs the same seed chain a
	// fresh ChatPage does — minus the conversation link, which does not exist yet.
	// The pick rides `initialAgent` into the tab it opens, so whatever resolves
	// here is what that chat starts on.
	const [agentId, setAgentId] = useState<string | null>(() =>
		seedComposerAgentId({ lastUsedAgentId: readLastUsedAgentId() })
	);
	const agentIdRef = useRef(agentId);
	agentIdRef.current = agentId;
	const [teamId, setTeamId] = useState<string | null>(null);
	const [selectedModel, setSelectedModel] = useState<string | null>(() =>
		getAgentModel(agentIdRef.current)
	);

	// Last link in the chain: the node-wide default (`default-agent-selection`).
	// Async, so it fills a hole rather than seeding — see `shouldAdoptNodeDefault`.
	const nodeDefaultAgentId = useNodeDefaultAgentId();
	useEffect(() => {
		if (shouldAdoptNodeDefault(agentIdRef.current, nodeDefaultAgentId)) {
			setAgentId(nodeDefaultAgentId);
			setSelectedModel(getAgentModel(nodeDefaultAgentId));
		}
	}, [nodeDefaultAgentId]);
	// Temporary chat, picked BEFORE the thread exists — the launchpad is the
	// new-chat surface, which is the only place ChatPage offers the toggle too. It
	// rides the tab seed so the spawned chat opens already unsaved.
	const [ghost, setGhost] = useState(false);
	const [temporaryMemory, setTemporaryMemory] = useState(false);
	const [isDragOver, setIsDragOver] = useState(false);
	const temporaryMemoryControl =
		useMemo<PluginComposerControlRow | null>(() => {
			const contribution = pluginContributions.composer_controls.find(
				(control) =>
					control.type === "toggle" && control.flag === TEMPORARY_CONTEXT_FLAG
			);
			if (!contribution) {
				return null;
			}
			return {
				description: contribution.description,
				enabled: temporaryMemory,
				flag: contribution.flag,
				id: contribution.id,
				label: contribution.label,
				onToggle: (_flag, next) => setTemporaryMemory(next),
			};
		}, [pluginContributions.composer_controls, temporaryMemory]);

	const modelOptions = useMemo(
		() => modelsForAgent(agentId, agents, engineModels),
		[agentId, agents, engineModels]
	);
	const effectiveModel =
		[selectedModel, getAgentModel(agentId)].find(
			(id) => id && modelOptions.some((m) => m.id === id)
		) ??
		modelOptions[0]?.id ??
		null;

	// Persist an engine-catalog model pick per-agent so the spawned chat surfaces it.
	const handleEngineModelChange = useCallback(
		(modelId: string) => {
			setSelectedModel(modelId);
			if (agentId) {
				setAgentModel(agentId, modelId);
			}
		},
		[agentId]
	);

	// Picking an agent clears any team target and becomes the remembered seed for
	// the next brand-new chat. It does NOT reach into any open chat tab: each one
	// owns its own target, pinned by its conversation.
	const handleSelectAgent = useCallback((next: string) => {
		setTeamId(null);
		setAgentId(next);
		rememberLastUsedAgent(next);
		setSelectedModel(getAgentModel(next));
	}, []);

	// The node the composer's mic / voice mode / image staging talk to.
	const target = useMemo(
		() => ({
			url: activeNode.url,
			token: activeNode.token,
			userJwt: activeNode.userJwt ?? null,
		}),
		[activeNode.url, activeNode.token]
	);

	// The launchpad owns its agent/model pick (persisted to localStorage) but
	// nothing else — those five bindings are all the shared composer needs.
	const runtime = useMemo(
		() => ({
			agentId,
			effectiveModel,
			modelOptions,
			setAgentId: handleSelectAgent,
			setModel: handleEngineModelChange,
		}),
		[
			agentId,
			effectiveModel,
			modelOptions,
			handleSelectAgent,
			handleEngineModelChange,
		]
	);

	// The ONE composer. No conversation id: the launchpad always opens a new chat,
	// so voice-mode turns stay ephemeral and `atConversationStart` derives true.
	const composer = useComposerSlot(runtime, {
		target,
		surface: "new-tab",
		teams,
		teamId,
		onSelectTeam: setTeamId,
		onCreateAgent: () => openCreateAgent(),
		ghost: { active: ghost, onToggle: () => setGhost((on) => !on) },
		pluginControls:
			ghost && temporaryMemoryControl ? [temporaryMemoryControl] : undefined,
	});
	const { addFiles, clear, images, onAttach, onPaste, onRemoveImage } =
		composer.attachments;
	const Composer = composer.inputBar;

	const handleDrop = useCallback(
		(e: DragEvent) => {
			e.preventDefault();
			setIsDragOver(false);
			addFiles(Array.from(e.dataTransfer.files));
		},
		[addFiles]
	);
	const composerNode = (
		<Composer
			attachedImages={images}
			autoFocus
			isDragOver={isDragOver}
			onAttach={onAttach}
			onPaste={onPaste}
			onRemoveImage={onRemoveImage}
			onSend={(message: { role: "user"; content: string }) => {
				const content = message.content.trim();
				if (!content && images.length === 0) {
					return;
				}
				openTab("/chat", {
					forceNew: true,
					initialPrompt: content,
					// User-initiated send: actually SEND it in the new chat tab, not
					// just pre-fill the composer (that's the deep-link/Inbox behavior).
					// A team target isn't carried into the tab, so for a team pick we
					// fall back to pre-fill rather than auto-send to the wrong agent.
					initialSubmit: true,
					initialImages: images.length > 0 ? images : undefined,
					initialAgent: teamId ? undefined : (agentId ?? undefined),
					initialTeamId: teamId ?? undefined,
					initialGhost: ghost ? true : undefined,
					initialPluginFlags: temporaryMemory
						? { [TEMPORARY_CONTEXT_FLAG]: true }
						: undefined,
				});
				// The images now live on the tab seed; drop them here so they don't
				// re-attach to the next thing typed on the launchpad.
				clear();
			}}
			onStop={() => undefined}
			placeholder="What do you want to do?"
			status="ready"
			workspaceBar={
				interfaceLevel === "simple" ? undefined : (
					<WorkspaceBar target={target} />
				)
			}
		/>
	);
	const renderedComposer = composer.voiceMode.active
		? composer.voiceMode.render(composerNode)
		: composerNode;

	return (
		<div
			className="relative"
			onDragLeave={(e) => {
				if (!e.currentTarget.contains(e.relatedTarget as Node)) {
					setIsDragOver(false);
				}
			}}
			onDragOver={(e) => {
				e.preventDefault();
				setIsDragOver(true);
			}}
			onDrop={handleDrop}
		>
			{renderedComposer}
		</div>
	);
}

/** Shown when every tab is closed — a personalized launchpad back into work. */
export function EmptyTabsState() {
	const { openTab } = useTabsContext();
	const { data: session } = useSession();
	const { agents } = useAgents();
	const { spaces } = useSpacesContext();
	const activeNode = useActiveNode();
	const [importOpen, setImportOpen] = useState(false);
	const [setupImportOpen, setSetupImportOpen] = useState(false);
	const importTarget = useMemo(
		() => ({
			url: activeNode.url,
			token: activeNode.token,
			userJwt: activeNode.userJwt ?? null,
		}),
		[activeNode.url, activeNode.token]
	);
	// Onboarding checklist, moved here from the chat page's empty state so the
	// launchpad is the single home for "get started" + recents. Self-removes
	// (allDone) once every quest is done.
	const {
		quests,
		completedCount,
		total,
		allDone: onboardingDone,
		run: runQuest,
	} = useGettingStarted();

	const name = firstName(session?.user?.name);

	const quickActions: QuickAction[] = [
		{
			label: "New chat",
			description: "Start a conversation",
			icon: MessageSquarePlus,
			onSelect: () => openTab("/chat", { forceNew: true }),
			primary: true,
		},
		{
			label: "Agents",
			description: "Build and run agents",
			icon: Bot,
			onSelect: () => openTab("/library/agent", { title: "Agents" }),
		},
		{
			label: "Import thread",
			description: "From Claude Code, Codex…",
			icon: Import,
			onSelect: () => setImportOpen(true),
		},
		{
			label: "Import setup",
			description: "Instructions, skills, MCP servers…",
			icon: Settings2,
			onSelect: () => setSetupImportOpen(true),
		},
		{
			label: "Spaces",
			description: "Knowledge for your agents",
			icon: Layers,
			onSelect: () => openTab("/library/space", { title: "Spaces" }),
		},
		{
			label: "Workflows",
			description: "Automate multi-step tasks",
			icon: Workflow,
			onSelect: () => openTab("/library/workflow", { title: "Workflows" }),
		},
		{
			label: "Customize",
			description: "Models, skills, and more",
			icon: Sparkles,
			onSelect: () => openTab("/store", { title: "Customize" }),
		},
	];

	const recentAgents = useMemo<RecentRow[]>(
		() =>
			[...agents]
				.sort(
					(a, b) =>
						normalizeTimestamp(b.createdAt) - normalizeTimestamp(a.createdAt)
				)
				.slice(0, RECENT_LIMIT)
				.map((a) => ({
					id: a.id,
					leading: (
						<AgentAvatar
							className="size-4 shrink-0 object-contain"
							engine={engineForAgent(a)}
							glyph={a.avatarGlyph}
							size="16px"
						/>
					),
					name: a.name,
					subtitle: a.description,
					open: () => openTab(`/agents/${a.id}/edit`, { title: a.name }),
				})),
		[agents, openTab]
	);

	const recentSpaces = useMemo<RecentRow[]>(
		() =>
			[...spaces]
				// Hide the auto-created Meetings space (it lives under Meetings).
				.filter((s) => s.name !== "Meetings")
				.sort(
					(a, b) =>
						normalizeTimestamp(b.updatedAt ?? b.createdAt) -
						normalizeTimestamp(a.updatedAt ?? a.createdAt)
				)
				.slice(0, RECENT_LIMIT)
				.map((s) => ({
					id: s.id,
					name: s.name,
					subtitle:
						s.description ??
						`${s.documentCount} ${s.documentCount === 1 ? "doc" : "docs"}`,
					open: () => {
						stampRecent("space", s.id);
						// Open the space itself (detail) rather than the Library list.
						openTab(`/spaces/${s.id}`, { title: s.name });
					},
				})),
		[spaces, openTab]
	);

	// Section order + drag-to-reorder, persisted to localStorage — mirrors the
	// app sidebar's section reordering (see AppSidebar's SectionDnd).
	const [order, setOrder] = useState<HomeSectionKey[]>(loadHomeSectionOrder);
	const [draggingKey, setDraggingKey] = useState<HomeSectionKey | null>(null);
	const [dragOverKey, setDragOverKey] = useState<HomeSectionKey | null>(null);

	const reorderSections = (next: HomeSectionKey[]) => {
		setOrder(next);
		saveHomeSectionOrder(next);
	};

	// Move the dragged section next to where it was dropped: below the original
	// inserts after the target, above inserts before — so every slot is reachable.
	const handleDropSection = (target: HomeSectionKey) => {
		if (draggingKey && draggingKey !== target) {
			const draggingDown = order.indexOf(draggingKey) < order.indexOf(target);
			const next = order.filter((k) => k !== draggingKey);
			const targetIdx = next.indexOf(target);
			next.splice(draggingDown ? targetIdx + 1 : targetIdx, 0, draggingKey);
			reorderSections(next);
		}
		setDraggingKey(null);
		setDragOverKey(null);
	};

	const sectionDnd: HomeSectionDnd = {
		draggingKey,
		dragOverKey,
		order,
		onDragStart: setDraggingKey,
		onDragEnd: () => {
			setDraggingKey(null);
			setDragOverKey(null);
		},
		onDragOver: (key) => setDragOverKey((prev) => (prev === key ? prev : key)),
		onDrop: handleDropSection,
	};

	const renderHomeSection = (key: HomeSectionKey) => {
		switch (key) {
			case "get-started":
				// Conditional + self-removing: the onboarding checklist only shows
				// while quests remain, but it's a first-class reorderable section so it
				// can be collapsed or moved like any other.
				if (onboardingDone) {
					return null;
				}
				return (
					<HomeSection
						dnd={sectionDnd}
						key={key}
						sectionKey={key}
						title={`Get started · ${completedCount}/${total}`}
					>
						<GettingStartedChecklist onRun={runQuest} quests={quests} />
					</HomeSection>
				);
			case "quick-actions":
				return (
					<HomeSection
						dnd={sectionDnd}
						key={key}
						sectionKey={key}
						title="Quick actions"
					>
						<div className="grid grid-cols-2 gap-3">
							{quickActions.map((action) => (
								<QuickActionCard action={action} key={action.label} />
							))}
						</div>
					</HomeSection>
				);
			case "agents":
				return (
					<HomeSection
						dnd={sectionDnd}
						key={key}
						onSeeAll={() => openTab("/library/agent", { title: "Agents" })}
						sectionKey={key}
						title="Recent agents"
					>
						<RecentList
							emptyHint="Agents you create appear here."
							rows={recentAgents}
						/>
					</HomeSection>
				);
			case "spaces":
				return (
					<HomeSection
						dnd={sectionDnd}
						key={key}
						onSeeAll={() => openTab("/library/space", { title: "Spaces" })}
						sectionKey={key}
						title="Recent spaces"
					>
						<RecentList
							emptyHint="Spaces you create appear here."
							rows={recentSpaces}
						/>
					</HomeSection>
				);
			default:
				return null;
		}
	};

	return (
		<div className="scroll-fade h-full w-full overflow-y-auto">
			{/* The no-tabs launchpad is vertically centered while still scrolling from
			    the top when the content is taller than the viewport. */}
			<div className="flex min-h-full flex-col justify-center">
				<div className="mx-auto flex w-full max-w-4xl flex-col gap-8 px-6 py-12">
					<header className="flex flex-col items-center gap-4 text-center">
						{/* Same staggered blur-rise entrance the onboarding + login headers
						    use (shared StaggerReveal), so the launchpad greeting settles in
						    on mount rather than hard-appearing. */}
						<StaggerReveal>
							<div className="shrink-0">
								<RyuLogo size="56px" variant="outline" />
							</div>
							<div className="space-y-1">
								<h1 className="font-heading text-[26px] text-foreground tracking-tight">
									{greeting()}
									{name ? `, ${name}` : ""}
								</h1>
							</div>
						</StaggerReveal>
					</header>

					<LaunchpadComposer />

					{/* Live activities — the "Dynamic Island" dock. Compact pills for
					    whatever is in progress (agent runs, downloads, approvals,
					    recording, contributed). Self-hides when nothing is live. */}
					<LiveActivityDock />

					{/* Every launchpad section — including the onboarding checklist — is
					    reorderable and collapsible; the render order is persisted. */}
					{/* TEMP: get-started, agents, spaces AND quick-actions sections hidden
					    on the no-tabs page per request — filtered out of the render (case
					    code kept intact so they can be restored by dropping the filter). */}
					<div className="flex flex-col gap-10">
						{order
							.filter(
								(key) =>
									key !== "get-started" &&
									key !== "agents" &&
									key !== "spaces" &&
									key !== "quick-actions"
							)
							.map((key) => renderHomeSection(key))}
					</div>
				</div>
			</div>
			<ImportThreadsDialog
				agents={agents}
				onImported={(conversationId) => openTab("/chat", { conversationId })}
				onOpenChange={setImportOpen}
				open={importOpen}
				target={importTarget}
			/>
			<ImportSetupDialog
				onOpenChange={setSetupImportOpen}
				open={setupImportOpen}
				target={importTarget}
			/>
		</div>
	);
}
