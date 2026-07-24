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
	Sparkles,
	Workflow,
} from "lucide-react";
import {
	type ClipboardEvent,
	type DragEvent,
	type ReactNode,
	useCallback,
	useMemo,
	useRef,
	useState,
} from "react";
import { useComposerAgentControls } from "@/components/agent-elements/input/composer-agent-controls.tsx";
import { handleComposerSettingsShortcut } from "@/components/agent-elements/input/composer-shortcuts.ts";
import { useComposerAcpSections } from "@/components/agent-elements/input/use-composer-acp-sections.ts";
import {
	type AttachedImage,
	InputBar,
} from "@/components/agent-elements/input-bar.tsx";
import { useSession } from "@/lib/auth-client.ts";
import { GettingStartedChecklist } from "@/src/components/chat/GettingStartedChecklist.tsx";
import { ImportThreadsDialog } from "@/src/components/chat/ImportThreadsDialog.tsx";
import { WorkspaceBar } from "@/src/components/chat/WorkspaceBar.tsx";
import { VoiceModeSurface } from "@/src/components/voice/VoiceModeSurface.tsx";
import { useSpacesContext } from "@/src/contexts/SpacesContext.tsx";
import { useTabsContext } from "@/src/contexts/TabsContext.tsx";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { useAgents } from "@/src/hooks/useAgents.ts";
import { useEngineModels } from "@/src/hooks/useEngineModels.ts";
import { useGettingStarted } from "@/src/hooks/useGettingStarted.ts";
import { useTeams } from "@/src/hooks/useTeams.ts";
import { useVoiceMode } from "@/src/hooks/useVoiceMode.ts";
import { AgentLogo, engineForAgent } from "@/src/lib/agent-logos.tsx";
import { transcribeAudio } from "@/src/lib/api/voice.ts";
import { normalizeTimestamp, stampRecent } from "@/src/lib/library.ts";
import {
	getAgentModel,
	modelsForAgent,
	setAgentModel,
} from "@/src/lib/models.ts";

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
						"pointer-events-none absolute inset-x-1 z-10 h-0.5 rounded-full bg-primary",
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
 * The real chat composer, surfaced on the launchpad — the same `InputBar` as
 * ChatPage with the full feature set, not a stripped launcher variant: the shared
 * agent/model pickers, the "+" attach button, live voice input (STT), and voice
 * mode. Sending opens a fresh chat tab seeded with the typed text, the chosen
 * agent, and any staged image attachments (which have no conversation to live on
 * yet, so they ride the tab seed into the new chat). The model pick is persisted
 * per-agent (`setAgentModel`), so the new chat surfaces the same agent/model.
 */
function LaunchpadComposer() {
	const { openTab } = useTabsContext();
	const { agents } = useAgents();
	const { teams } = useTeams();
	const engineModels = useEngineModels();
	const activeNode = useActiveNode();

	const [agentId, setAgentId] = useState<string | null>(() =>
		localStorage.getItem("ryu_default_agent")
	);
	const [teamId, setTeamId] = useState<string | null>(null);
	const [selectedModel, setSelectedModel] = useState<string | null>(() =>
		getAgentModel(localStorage.getItem("ryu_default_agent"))
	);

	// Staged image attachments — the launcher has no conversation yet, so they're
	// carried into the fresh chat tab on send (via the `initialImages` tab seed).
	const [attachedImages, setAttachedImages] = useState<AttachedImage[]>([]);
	const [isDragOver, setIsDragOver] = useState(false);

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

	// The agent's ACP-advertised Model + Thinking/approval selectors, derived the
	// exact same way ChatPage derives them (shared hook), so the launchpad dropdown
	// reads identically — even though no chat exists yet. Picks persist per-agent
	// and are honoured by the new chat on send.
	const acp = useComposerAcpSections({
		agentId,
		agents,
		modelOptions,
		engineModel: effectiveModel,
		onEngineModelChange: handleEngineModelChange,
	});

	// The agent + model pickers are the shared composer controls, so the launchpad
	// reads identically to ChatPage and the Ask Ryu dock. The launchpad owns its
	// own agent selection state (persisted to localStorage); the shared hook renders
	// the pickers and dispatches create / team / agent picks back to these setters.
	const { leftActions, rightActions, sections } = useComposerAgentControls({
		agents,
		teams,
		agentId,
		teamId,
		onSelectAgent: (next) => {
			setTeamId(null);
			setAgentId(next);
			localStorage.setItem("ryu_default_agent", next);
			setSelectedModel(getAgentModel(next));
		},
		onSelectTeam: (next) => setTeamId(next),
		onCreateAgent: () => openTab("/agents/new/edit", { title: "New agent" }),
		modelOptions,
		model: effectiveModel,
		onModelChange: handleEngineModelChange,
		modelSection: acp.modelSection,
		extraSections: acp.extraSections,
	});

	// Voice: the node target the mic/voice-mode talk to. Read via a ref so the
	// transcribe fn keeps a stable identity (no composer remount on node change).
	const target = useMemo(
		() => ({ url: activeNode.url, token: activeNode.token ?? null }),
		[activeNode.url, activeNode.token]
	);
	const targetRef = useRef(target);
	targetRef.current = target;
	const voiceTranscribe = useCallback(
		(audio: Blob) => transcribeAudio(targetRef.current, audio),
		[]
	);
	// Voice mode routes ephemerally through the picked agent — there's no
	// conversation on the launcher, so turns don't persist to a thread (the user
	// can start from a real chat for that).
	const voiceMode = useVoiceMode(target, { agentId: agentId ?? undefined });

	const addImages = useCallback((files: File[]) => {
		const imageFiles = files.filter((f) => f.type.startsWith("image/"));
		for (const file of imageFiles) {
			const reader = new FileReader();
			reader.onload = () => {
				setAttachedImages((prev) => [
					...prev,
					{
						id: `img-${Date.now()}-${Math.random()}`,
						filename: file.name,
						url: reader.result as string,
						mimeType: file.type,
						size: file.size,
					},
				]);
			};
			reader.readAsDataURL(file);
		}
	}, []);

	const handleAttach = useCallback(() => {
		const input = document.createElement("input");
		input.type = "file";
		input.accept = "image/*";
		input.multiple = true;
		input.onchange = () => {
			if (input.files) {
				addImages(Array.from(input.files));
			}
		};
		input.click();
	}, [addImages]);

	const handlePaste = useCallback(
		(e: ClipboardEvent) => addImages(Array.from(e.clipboardData.files)),
		[addImages]
	);

	const handleDrop = useCallback(
		(e: DragEvent) => {
			e.preventDefault();
			setIsDragOver(false);
			addImages(Array.from(e.dataTransfer.files));
		},
		[addImages]
	);

	const handleRemoveImage = useCallback(
		(id: string) =>
			setAttachedImages((prev) => prev.filter((img) => img.id !== id)),
		[]
	);

	return (
		<>
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
				<InputBar
					attachedImages={attachedImages}
					autoFocus
					isDragOver={isDragOver}
					leftActions={leftActions}
					onAttach={handleAttach}
					onPaste={handlePaste}
					onRemoveImage={handleRemoveImage}
					onSend={(message: { role: "user"; content: string }) => {
						const content = message.content.trim();
						if (!content && attachedImages.length === 0) {
							return;
						}
						openTab("/chat", {
							forceNew: true,
							initialPrompt: content,
							// User-initiated send: actually SEND it in the new chat tab, not
							// just pre-fill the composer (that's the deep-link/Inbox behavior).
							// A team target isn't carried into the tab, so for a team pick we
							// fall back to pre-fill rather than auto-send to the wrong agent.
							initialSubmit: teamId ? undefined : true,
							initialImages:
								attachedImages.length > 0 ? attachedImages : undefined,
							initialAgent: teamId ? undefined : (agentId ?? undefined),
						});
					}}
					onStop={() => undefined}
					onTextareaKeyDown={(event) => {
						if (handleComposerSettingsShortcut(event, sections)) {
							event.preventDefault();
						}
					}}
					placeholder="Ask anything, or start a new chat…"
					rightActions={rightActions}
					status="ready"
					voice={{ transcribe: voiceTranscribe }}
					voiceMode={{ onStart: voiceMode.start }}
					workspaceBar={<WorkspaceBar target={target} />}
				/>
			</div>
			{voiceMode.active && <VoiceModeSurface voice={voiceMode} />}
		</>
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
	const importTarget = useMemo(
		() => ({ url: activeNode.url, token: activeNode.token ?? null }),
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
						normalizeTimestamp(b.updatedAt ?? b.createdAt) -
						normalizeTimestamp(a.updatedAt ?? a.createdAt)
				)
				.slice(0, RECENT_LIMIT)
				.map((a) => ({
					id: a.id,
					leading: (
						<AgentLogo
							className="size-4 shrink-0 object-contain"
							engine={engineForAgent(a)}
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
		<div className="h-full w-full overflow-y-auto">
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
		</div>
	);
}
