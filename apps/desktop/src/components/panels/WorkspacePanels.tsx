import {
	ArrowDown01Icon,
	BrowserIcon,
	Cancel01Icon,
	CheckListIcon,
	ComputerTerminal01Icon,
	DashboardSquare01Icon,
	FileCodeIcon,
	FolderOpenIcon,
	Globe02Icon,
	PlusSignIcon,
	RefreshIcon,
	Robot01Icon,
	SourceCodeIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { PatchDiff } from "@pierre/diffs/react";
import { FileTree, useFileTree } from "@pierre/trees/react";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
	DropdownMenuTrigger,
} from "@ryu/ui/components/dropdown-menu";
import { SidebarContent, SidebarGroup } from "@ryu/ui/components/sidebar";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip";
import { cn } from "@ryu/ui/lib/utils";
import { invoke } from "@tauri-apps/api/core";
import { useTheme } from "next-themes";
import type {
	KeyboardEvent,
	MouseEvent as ReactMouseEvent,
	ReactNode,
} from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MessageList } from "@/components/agent-elements/message-list.tsx";
import { ArtifactRenderer } from "@/src/components/chat/ArtifactRenderer.tsx";
import {
	type InspectedPart,
	PartInspector,
} from "@/src/components/chat/PartInspector.tsx";
import type { CoworkContextPanelProps } from "@/src/components/panels/CoworkContextPanel.tsx";
import {
	CoworkContextPanel,
	extractSubagents,
} from "@/src/components/panels/CoworkContextPanel.tsx";
import { SubagentAvatar } from "@/src/components/panels/subagent-identity.tsx";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { useApps } from "@/src/hooks/useApps.ts";
import { apiUrl, makeHeaders } from "@/src/lib/api/client.ts";
import type { Artifact } from "@/src/lib/artifacts.ts";
import { useWorkspaceStore } from "@/src/store/useWorkspaceStore.ts";

// ── Panel layout icons — same visual language as SidebarToggleIcon ────────────

const RING_PATH =
	"M9.35719 3H14.6428C15.7266 2.99999 16.6007 2.99998 17.3086 3.05782C18.0375 3.11737 18.6777 3.24318 19.27 3.54497C20.2108 4.02433 20.9757 4.78924 21.455 5.73005C21.7568 6.32234 21.8826 6.96253 21.9422 7.69138C22 8.39925 22 9.27339 22 10.3572V13.6428C22 14.7266 22 15.6008 21.9422 16.3086C21.8826 17.0375 21.7568 17.6777 21.455 18.27C20.9757 19.2108 20.2108 19.9757 19.27 20.455C18.6777 20.7568 18.0375 20.8826 17.3086 20.9422C16.6008 21 15.7266 21 14.6428 21H9.35717C8.27339 21 7.39925 21 6.69138 20.9422C5.96253 20.8826 5.32234 20.7568 4.73005 20.455C3.78924 19.9757 3.02433 19.2108 2.54497 18.27C2.24318 17.6777 2.11737 17.0375 2.05782 16.3086C1.99998 15.6007 1.99999 14.7266 2 13.6428V10.3572C1.99999 9.27341 1.99998 8.39926 2.05782 7.69138C2.11737 6.96253 2.24318 6.32234 2.54497 5.73005C3.02433 4.78924 3.78924 4.02433 4.73005 3.54497C5.32234 3.24318 5.96253 3.11737 6.69138 3.05782C7.39926 2.99998 8.27341 2.99999 9.35719 3ZM6.85424 5.05118C6.24907 5.10062 5.90138 5.19279 5.63803 5.32698C5.07354 5.6146 4.6146 6.07354 4.32698 6.63803C4.19279 6.90138 4.10062 7.24907 4.05118 7.85424C4.00078 8.47108 4 9.26339 4 10.4V13.6C4 14.7366 4.00078 15.5289 4.05118 16.1458C4.10062 16.7509 4.19279 17.0986 4.32698 17.362C4.6146 17.9265 5.07354 18.3854 5.63803 18.673C5.90138 18.8072 6.24907 18.8994 6.85424 18.9488C7.47108 18.9992 8.26339 19 9.4 19H14.6C15.7366 19 16.5289 18.9992 17.1458 18.9488C17.7509 18.8994 18.0986 18.8072 18.362 18.673C18.9265 18.3854 19.3854 17.9265 19.673 17.362C19.8072 17.0986 19.8994 16.7509 19.9488 16.1458C19.9992 15.5289 20 14.7366 20 13.6V10.4C20 9.26339 19.9992 8.47108 19.9488 7.85424C19.8994 7.24907 19.8072 6.90138 19.673 6.63803C19.3854 6.07354 18.9265 5.6146 18.362 5.32698C18.0986 5.19279 17.7509 5.10062 17.1458 5.05118C16.5289 5.00078 15.7366 5 14.6 5H9.4C8.26339 5 7.47108 5.00078 6.85424 5.05118Z";
const URL_PROTOCOL_RE = /^https?:\/\//i;
const PATH_SEPARATOR_RE = /[\\/]/;

// Open: solid filled strip on the edge → the panel is docked and visible.
// Closed: thin line on the edge → the panel is hidden but lives there.
// Same ring/visual language as the left sidebar's IconSidebarOpen/Closed pair.

function BottomPanelIconOpen({ className }: { className?: string }) {
	return (
		<svg
			aria-hidden="true"
			className={className}
			fill="none"
			viewBox="0 0 24 24"
		>
			<g transform="scale(1.05, 1.05) translate(-1.5, -1.15)">
				<path
					clipRule="evenodd"
					d={RING_PATH}
					fill="currentColor"
					fillRule="evenodd"
				/>
				<path d="M4 14H20V19H4V14Z" fill="currentColor" />
			</g>
		</svg>
	);
}

function BottomPanelIconClosed({ className }: { className?: string }) {
	return (
		<svg
			aria-hidden="true"
			className={className}
			fill="none"
			viewBox="0 0 24 24"
		>
			<g transform="scale(1.05, 1.05) translate(-1.5, -1.15)">
				<path
					clipRule="evenodd"
					d={RING_PATH}
					fill="currentColor"
					fillRule="evenodd"
				/>
				<path d="M4 17H20V19H4V17Z" fill="currentColor" />
			</g>
		</svg>
	);
}

function RightPanelIconOpen({ className }: { className?: string }) {
	return (
		<svg
			aria-hidden="true"
			className={className}
			fill="none"
			viewBox="0 0 24 24"
		>
			<g transform="scale(1.05, 1.05) translate(-1.5, -1.15)">
				<path
					clipRule="evenodd"
					d={RING_PATH}
					fill="currentColor"
					fillRule="evenodd"
				/>
				<path d="M13 5H20V19H13V5Z" fill="currentColor" />
			</g>
		</svg>
	);
}

function RightPanelIconClosed({ className }: { className?: string }) {
	return (
		<svg
			aria-hidden="true"
			className={className}
			fill="none"
			viewBox="0 0 24 24"
		>
			<g transform="scale(1.05, 1.05) translate(-1.5, -1.15)">
				<path
					clipRule="evenodd"
					d={RING_PATH}
					fill="currentColor"
					fillRule="evenodd"
				/>
				<path d="M17 5H20V19H17V5Z" fill="currentColor" />
			</g>
		</svg>
	);
}

// ── Editor open buttons (split button group with chevron) ─────────────────────

// An icon source is either a single asset or a light/dark themed pair.
type SvglSlug = string | { dark: string; light: string };

// Inline glyphs rendered with `currentColor` so they follow the toolbar text
// colour in both light and dark themes. (An external SVG loaded via <img> cannot
// inherit `currentColor`, so monochrome brand marks must be inlined, not <img>'d.)
type EditorGlyph = "terminal" | "windows-terminal" | "cmd" | "folder";

interface EditorDef {
	// Brand icon resolution order: a bundled local SVG (full /assets path), then a
	// remote svgl logo (slug), then the inline `glyph` as the final theme-safe fallback.
	glyph: EditorGlyph;
	id: string;
	label: string;
	localSrc?: SvglSlug;
	shortLabel: string;
	svglSlug?: SvglSlug | null;
}

// The system file manager is named differently per OS, so label it to match
// what the user actually sees: Finder on macOS, Explorer on Windows, Files on Linux.
const IS_MAC = navigator.userAgent.includes("Mac");
const IS_WINDOWS = navigator.userAgent.includes("Windows");
let fileManagerName = "Files";
if (IS_MAC) {
	fileManagerName = "Finder";
} else if (IS_WINDOWS) {
	fileManagerName = "Explorer";
}

// cmd.exe and PowerShell are Windows-specific shells, so only offer them there.
const WINDOWS_SHELL_DEFS: EditorDef[] = IS_WINDOWS
	? [
			{
				id: "powershell",
				label: "Open PowerShell",
				shortLabel: "PowerShell",
				localSrc: "/assets/logos/powershell.svg",
				glyph: "terminal",
			},
			{
				id: "cmd",
				label: "Open Command Prompt",
				shortLabel: "Command Prompt",
				glyph: "cmd",
			},
		]
	: [];

const FILE_MANAGER_LOGO_SRC = IS_MAC ? "/assets/logos/finder.png" : undefined;
const PLATFORM_FILE_MANAGER_LOGO_SRC = IS_WINDOWS
	? "/assets/logos/windows-explorer.svg"
	: FILE_MANAGER_LOGO_SRC;

const EDITOR_DEFS: EditorDef[] = [
	{
		id: "vscode",
		label: "Open in VS Code",
		shortLabel: "VS Code",
		svglSlug: "vscode",
		glyph: "folder",
	},
	{
		id: "cursor",
		label: "Open in Cursor",
		shortLabel: "Cursor",
		svglSlug: { light: "cursor_light", dark: "cursor_dark" },
		glyph: "folder",
	},
	{
		id: "zed",
		label: "Open in Zed",
		shortLabel: "Zed",
		svglSlug: { light: "zed-logo", dark: "zed-logo_dark" },
		glyph: "folder",
	},
	{
		id: "gitbash",
		label: "Open in Git Bash",
		shortLabel: "Git Bash",
		svglSlug: "git",
		glyph: "terminal",
	},
	{
		id: "terminal",
		label: "Open Terminal",
		shortLabel: "Terminal",
		// Inline Windows Terminal mark (currentColor) — the launcher runs `wt`.
		glyph: "windows-terminal",
	},
	...WINDOWS_SHELL_DEFS,
	{
		id: "explorer",
		label: `Show in ${fileManagerName}`,
		shortLabel: fileManagerName,
		// Authentic file-manager marks where available; neutral folder glyph as the
		// final fallback for Linux/other desktops.
		localSrc: PLATFORM_FILE_MANAGER_LOGO_SRC,
		svglSlug: null,
		glyph: "folder",
	},
];

const WINDOWS_TERMINAL_PATH =
	"M8.165 6V3h7.665v3H8.165zm-.5-3H1c-.55 0-1 .45-1 1v2h7.665V3zM23 3h-6.67v3H24V4c0-.55-.45-1-1-1zM0 6.5h24V20c0 .55-.45 1-1 1H1c-.55 0-1-.45-1-1V6.5zM11.5 18c0 .3.2.5.5.5h8c.3 0 .5-.2.5-.5v-1.5c0-.3-.2-.5-.5-.5h-8c-.3 0-.5.2-.5.5V18zm-5.2-4.55l-3.1 3.1c-.25.25-.25.6 0 .8l.9.9c.25.25.6.25.8 0l4.4-4.4a.52.52 0 0 0 0-.8l-4.4-4.4c-.2-.2-.6-.2-.8 0l-.9.9c-.25.2-.25.55 0 .8l3.1 3.1z";
const CMD_PATH =
	"M12.5 1h-9A2.5 2.5 0 0 0 1 3.5v9A2.5 2.5 0 0 0 3.5 15h9a2.5 2.5 0 0 0 2.5-2.5v-9A2.5 2.5 0 0 0 12.5 1M14 12.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 12.5V5h12zM14 4H2v-.5A1.5 1.5 0 0 1 3.5 2h9A1.5 1.5 0 0 1 14 3.5zM4 10.508v-2c0-.827.673-1.5 1.5-1.5s1.5.673 1.5 1.5a.5.5 0 0 1-1 0a.5.5 0 0 0-1 0v2a.5.5 0 0 0 1 0a.5.5 0 0 1 1 0c0 .827-.673 1.5-1.5 1.5s-1.5-.673-1.5-1.5M8 8.5a.5.5 0 1 1 1 0a.5.5 0 0 1-1 0m0 2a.5.5 0 1 1 1 0a.5.5 0 0 1-1 0m1.532-2.824a.5.5 0 0 1 .292-.644a.5.5 0 0 1 .644.292l1.5 4A.5.5 0 0 1 11.5 12a.5.5 0 0 1-.468-.324z";

function GlyphIcon({ glyph }: { glyph: EditorGlyph }) {
	if (glyph === "windows-terminal") {
		return (
			<svg
				aria-hidden="true"
				className="size-3.5 shrink-0"
				fill="currentColor"
				viewBox="0 0 24 24"
			>
				<path d={WINDOWS_TERMINAL_PATH} />
			</svg>
		);
	}
	if (glyph === "cmd") {
		return (
			<svg
				aria-hidden="true"
				className="size-3.5 shrink-0"
				fill="currentColor"
				viewBox="0 0 16 16"
			>
				<path d={CMD_PATH} />
			</svg>
		);
	}
	if (glyph === "terminal") {
		return <HugeiconsIcon className="size-3.5" icon={ComputerTerminal01Icon} />;
	}
	return <HugeiconsIcon className="size-3.5" icon={FolderOpenIcon} />;
}

// Bundled editor/tool marks (originally svgl.app) served from the desktop public
// dir. `LogoImg` still falls back to the inline `glyph` if a file is missing.
const svglUrl = (slug: string) => `/assets/logos/${slug}.svg`;
const localUrl = (path: string) => path;

function LogoImg({
	spec,
	resolveUrl,
	glyph,
	label,
}: {
	spec: SvglSlug;
	resolveUrl: (value: string) => string;
	glyph: EditorGlyph;
	label: string;
}) {
	const { resolvedTheme } = useTheme();
	const [failed, setFailed] = useState(false);
	let resolved = spec;
	if (typeof spec !== "string") {
		resolved = resolvedTheme === "dark" ? spec.dark : spec.light;
	}
	if (failed) {
		return <GlyphIcon glyph={glyph} />;
	}
	return (
		<img
			alt={label}
			className="size-3.5 shrink-0 object-contain"
			// Re-fetch (and reset the fallback) when the themed variant changes.
			key={resolved as string}
			onError={() => setFailed(true)}
			src={resolveUrl(resolved as string)}
		/>
	);
}

function EditorIcon({ def }: { def: EditorDef }) {
	if (def.localSrc) {
		return (
			<LogoImg
				glyph={def.glyph}
				label={def.label}
				resolveUrl={localUrl}
				spec={def.localSrc}
			/>
		);
	}
	if (def.svglSlug) {
		return (
			<LogoImg
				glyph={def.glyph}
				label={def.label}
				resolveUrl={svglUrl}
				spec={def.svglSlug}
			/>
		);
	}
	return <GlyphIcon glyph={def.glyph} />;
}

function EditorButtonGroup({ folder }: { folder?: string | null }) {
	const [activeId, setActiveId] = useState("explorer");
	const [availableEditorIds, setAvailableEditorIds] = useState<Set<string>>(
		() => new Set(["explorer"])
	);
	const editorDefs = useMemo(
		() => EDITOR_DEFS.filter((def) => availableEditorIds.has(def.id)),
		[availableEditorIds]
	);
	const activeDef =
		editorDefs.find((d) => d.id === activeId) ??
		editorDefs.find((d) => d.id === "explorer") ??
		editorDefs[0] ??
		EDITOR_DEFS[0];

	useEffect(() => {
		let cancelled = false;
		invoke<Array<{ available: boolean; id: string }>>(
			"get_editor_availability",
			{
				editors: EDITOR_DEFS.map((def) => def.id),
			}
		)
			.then((items) => {
				if (cancelled) {
					return;
				}
				const next = new Set(
					items.filter((item) => item.available).map((item) => item.id)
				);
				next.add("explorer");
				setAvailableEditorIds(next);
				setActiveId((current) => (next.has(current) ? current : "explorer"));
			})
			.catch((e) => {
				console.error("get_editor_availability:", e);
			});
		return () => {
			cancelled = true;
		};
	}, []);

	const run = async (id: string) => {
		setActiveId(id);
		try {
			await invoke("open_in_editor", { editor: id, path: folder ?? null });
		} catch (e) {
			console.error("open_in_editor:", e);
		}
	};

	return (
		<div className="flex items-center">
			<Tooltip>
				<TooltipTrigger
					render={
						<button
							className="flex h-7 items-center px-1.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
							onClick={() => run(activeDef.id)}
							type="button"
						>
							<EditorIcon def={activeDef} />
						</button>
					}
				/>
				<TooltipContent>{`${activeDef.label}${folder ? `: ${folder}` : ""}`}</TooltipContent>
			</Tooltip>
			<DropdownMenu>
				<DropdownMenuTrigger
					aria-label="Choose editor"
					className="flex h-7 items-center px-0.5 text-muted-foreground transition-colors hover:text-foreground"
				>
					<HugeiconsIcon className="size-3" icon={ArrowDown01Icon} />
				</DropdownMenuTrigger>
				<DropdownMenuContent align="start" side="bottom">
					{editorDefs.map((def) => (
						<DropdownMenuItem
							className={cn(
								"gap-2.5 text-xs",
								def.id === activeId
									? "text-foreground"
									: "text-muted-foreground"
							)}
							key={def.id}
							onClick={() => run(def.id)}
						>
							<EditorIcon def={def} />
							{def.shortLabel}
							{def.id === activeId && (
								<span className="ml-auto text-[10px] opacity-50">active</span>
							)}
						</DropdownMenuItem>
					))}
				</DropdownMenuContent>
			</DropdownMenu>
		</div>
	);
}

// ── Multi-instance tab system ─────────────────────────────────────────────────

type TabKind =
	| "terminal"
	| "codereview"
	| "browser"
	| "files"
	| "cowork"
	| "subagent"
	| "artifact"
	| "inspector";

interface PanelTab {
	kind: TabKind;
	label: string;
	uid: string;
}

interface TabTypeDef {
	icon: typeof ComputerTerminal01Icon;
	kind: TabKind;
	label: string;
}

const BOTTOM_TAB_TYPES: TabTypeDef[] = [
	{ kind: "terminal", label: "Terminal", icon: ComputerTerminal01Icon },
	{ kind: "codereview", label: "Code Review", icon: FileCodeIcon },
	{ kind: "browser", label: "Browser", icon: Globe02Icon },
];

const RIGHT_TAB_TYPES: TabTypeDef[] = [
	{ kind: "files", label: "Files", icon: FolderOpenIcon },
	{ kind: "codereview", label: "Changes", icon: FileCodeIcon },
	{ kind: "browser", label: "Browser", icon: Globe02Icon },
];

let tabCounter = 0;
function makeTab(kind: TabKind, label: string, n?: number): PanelTab {
	tabCounter += 1;
	return {
		uid: `tab-${tabCounter}`,
		kind,
		label: n == null ? label : `${label} ${n}`,
	};
}

function usePanelTabs(initial: PanelTab[]) {
	const [tabs, setTabs] = useState<PanelTab[]>(initial);
	const [activeUid, setActiveUid] = useState(initial[0]?.uid ?? "");

	const addTab = (kind: TabKind, label: string) => {
		const sameKind = tabs.filter((t) => t.kind === kind);
		const tab = makeTab(kind, label, sameKind.length + 1);
		setTabs((prev) => [...prev, tab]);
		setActiveUid(tab.uid);
	};

	const closeTab = (uid: string) => {
		setTabs((prev) => {
			const next = prev.filter((t) => t.uid !== uid);
			if (activeUid === uid) {
				setActiveUid(next.at(-1)?.uid ?? "");
			}
			return next;
		});
	};

	// Open a single reusable tab of a kind: focus the existing one (updating its
	// label) or create it. Used to surface a clicked subagent's transcript without
	// stacking a new tab per click.
	const openTab = useCallback(
		(kind: TabKind, label: string) => {
			const existing = tabs.find((t) => t.kind === kind);
			if (existing) {
				setTabs((prev) =>
					prev.map((t) => (t.uid === existing.uid ? { ...t, label } : t))
				);
				setActiveUid(existing.uid);
				return;
			}
			const tab = makeTab(kind, label);
			setTabs((prev) => [...prev, tab]);
			setActiveUid(tab.uid);
		},
		[tabs]
	);

	return { tabs, activeUid, setActiveUid, addTab, closeTab, openTab };
}

interface PanelTabBarProps {
	activeUid: string;
	addTypes: TabTypeDef[];
	onActivate: (uid: string) => void;
	onAdd: (kind: TabKind) => void;
	onClosePanel: () => void;
	onCloseTab: (uid: string) => void;
	tabs: PanelTab[];
}

function PanelTabBar({
	tabs,
	activeUid,
	onActivate,
	onCloseTab,
	onAdd,
	addTypes,
	onClosePanel,
}: PanelTabBarProps) {
	const iconFor = (kind: TabKind) => {
		if (kind === "terminal") {
			return ComputerTerminal01Icon;
		}
		if (kind === "codereview") {
			return FileCodeIcon;
		}
		if (kind === "files") {
			return FolderOpenIcon;
		}
		if (kind === "cowork") {
			return DashboardSquare01Icon;
		}
		if (kind === "subagent") {
			return Robot01Icon;
		}
		if (kind === "artifact") {
			return BrowserIcon;
		}
		if (kind === "inspector") {
			return SourceCodeIcon;
		}
		return Globe02Icon;
	};

	return (
		<div className="flex shrink-0 items-center border-border/60 border-b bg-sidebar">
			{tabs.map((tab) => (
				<div
					className={cn(
						"group flex h-9 shrink-0 cursor-pointer select-none items-center gap-1.5 border-b-2 px-3 font-medium text-xs transition-colors",
						activeUid === tab.uid
							? "border-primary bg-background/60 text-foreground"
							: "border-transparent text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
					)}
					key={tab.uid}
					// biome-ignore lint/a11y/useKeyWithClickEvents: tab row click is intentional
					onClick={() => onActivate(tab.uid)}
				>
					<HugeiconsIcon
						className="size-3.5 shrink-0"
						icon={iconFor(tab.kind)}
					/>
					{tab.label}
					<Tooltip>
						<TooltipTrigger
							render={
								<button
									aria-label="Close tab"
									className="hover:!opacity-100 ml-0.5 flex size-3.5 shrink-0 items-center justify-center rounded opacity-0 transition-opacity group-hover:opacity-60"
									onClick={(e) => {
										e.stopPropagation();
										onCloseTab(tab.uid);
									}}
									type="button"
								>
									<HugeiconsIcon className="size-2.5" icon={Cancel01Icon} />
								</button>
							}
						/>
						<TooltipContent>Close tab</TooltipContent>
					</Tooltip>
				</div>
			))}

			{/* Add tab button + dropdown */}
			<DropdownMenu>
				<DropdownMenuTrigger
					aria-label="New tab"
					className="ml-0.5 flex size-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
				>
					<HugeiconsIcon className="size-3.5" icon={PlusSignIcon} />
				</DropdownMenuTrigger>
				<DropdownMenuContent align="start" side="bottom">
					{addTypes.map((t) => (
						<DropdownMenuItem
							className="gap-2.5 text-xs"
							key={t.kind}
							onClick={() => onAdd(t.kind)}
						>
							<HugeiconsIcon className="size-3.5 shrink-0" icon={t.icon} />
							{t.label}
						</DropdownMenuItem>
					))}
				</DropdownMenuContent>
			</DropdownMenu>

			<div className="flex-1" />

			<Tooltip>
				<TooltipTrigger
					render={
						<button
							aria-label="Close panel"
							className="mr-1 flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
							onClick={onClosePanel}
							type="button"
						>
							<HugeiconsIcon className="size-3.5" icon={Cancel01Icon} />
						</button>
					}
				/>
				<TooltipContent>Close panel</TooltipContent>
			</Tooltip>
		</div>
	);
}

// ── Empty panel state (launchpad) ─────────────────────────────────────────────

// Shown when a panel has zero open tabs — the same launchpad idea as the no-tabs
// home page (EmptyTabsState): rather than a bare placeholder, offer the openable
// tab types as quick-action cards. The cards wrap, so this reads well both in the
// narrow right dock (cards stack) and the short-wide bottom dock (cards sit in a
// row). `addTypes` is the same list that feeds the "+" menu, so the two stay in
// sync automatically.
function PanelEmptyState({
	addTypes,
	onAdd,
}: {
	addTypes: TabTypeDef[];
	onAdd: (kind: TabKind) => void;
}) {
	return (
		<div className="flex h-full w-full items-center justify-center overflow-auto p-6">
			<div className="flex flex-col items-center gap-4">
				<p className="text-center text-muted-foreground text-xs">
					No tabs open. Open one to get started.
				</p>
				<div className="flex flex-wrap items-stretch justify-center gap-2">
					{addTypes.map((t) => (
						<button
							className="group flex w-36 flex-col justify-between gap-3 rounded-xl bg-muted/50 p-3 text-left transition-colors hover:bg-muted/70"
							key={t.kind}
							onClick={() => onAdd(t.kind)}
							type="button"
						>
							<HugeiconsIcon
								className="size-5 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground"
								icon={t.icon}
							/>
							<span className="truncate font-medium text-foreground text-sm">
								{t.label}
							</span>
						</button>
					))}
				</div>
			</div>
		</div>
	);
}

// ── File tree panel (@pierre/trees) ──────────────────────────────────────────

function FileTreePanel({ folder }: { folder?: string | null }) {
	const [paths, setPaths] = useState<readonly string[]>([]);
	const [loading, setLoading] = useState(false);
	const terminalShell = useWorkspaceStore((s) => s.terminalShell);

	useEffect(() => {
		if (!folder) {
			setPaths([]);
			return;
		}
		setLoading(true);
		const shellArg = terminalShell === "auto" ? null : terminalShell;
		// All project files, not just tracked ones: `--cached` (tracked) +
		// `--others` (untracked) − `--exclude-standard` (drops .gitignore noise
		// like node_modules/target). This is what an IDE file tree shows.
		invoke<{ stdout: string; stderr: string; code: number }>("shell_execute", {
			command: "git ls-files --cached --others --exclude-standard",
			cwd: folder,
			shell: shellArg,
		})
			.then((r) => setPaths(r.stdout.trim().split("\n").filter(Boolean)))
			.catch(() => setPaths([]))
			.finally(() => setLoading(false));
	}, [folder, terminalShell]);

	const { model } = useFileTree({ paths });

	if (!folder) {
		return (
			<div className="flex h-full items-center justify-center text-muted-foreground text-xs">
				No project folder open.
			</div>
		);
	}

	if (loading) {
		return (
			<div className="flex h-full animate-pulse items-center justify-center text-muted-foreground text-xs">
				Loading files...
			</div>
		);
	}

	if (paths.length === 0) {
		return (
			<div className="flex h-full items-center justify-center p-4 text-center text-muted-foreground text-xs">
				No files found. This folder is empty or not a git repository.
			</div>
		);
	}

	// @pierre/trees virtualizes by default: its host is `height: 100%` and the
	// inner scroll container is `flex: 1; min-height: 0`, so it only renders rows
	// when every ancestor has a definite height. Without `flex-1`/`h-full` down
	// the chain the tree collapses to 0px and shows nothing — keep these.
	return (
		<SidebarContent className="h-full w-full overflow-hidden">
			<SidebarGroup className="min-h-0 flex-1 p-1">
				<FileTree className="h-full w-full" model={model} />
			</SidebarGroup>
		</SidebarContent>
	);
}

// ── Code review panel (@pierre/diffs) ────────────────────────────────────────

// What the diff is computed against. The git command for each lives in
// `buildDiffCommand` below — nothing about the source is hardcoded into render.
type DiffMode = "working" | "staged" | "commit" | "branch";

interface CommitInfo {
	sha: string;
	subject: string;
}

// `%x09` makes git emit a real tab between the hash and the subject, so we let
// git insert the delimiter instead of pushing a control char through the shell.
const GIT_LOG_FORMAT = "%H%x09%s";

function shortSha(sha: string) {
	return sha.slice(0, 7);
}

// `shell_execute` runs the command string through a full shell (`bash -c` /
// `powershell -Command`), and git ref names can legally contain shell
// metacharacters (`$ ; ( ) & |` …), so interpolating a ref/SHA from an untrusted
// repo could inject commands or git flags. Allow only safe ref characters and
// reject a leading `-` (argument injection). Refs that fail validation fall
// through to the safe default below rather than being interpolated.
const SAFE_GIT_REF = /^[A-Za-z0-9._/-]+$/;
function isSafeGitRef(ref: string): boolean {
	return ref.length > 0 && !ref.startsWith("-") && SAFE_GIT_REF.test(ref);
}

function buildDiffCommand(
	mode: DiffMode,
	commit: CommitInfo | null,
	branch: string | null
): string {
	if (mode === "staged") {
		return "git diff --staged";
	}
	if (mode === "commit" && commit && isSafeGitRef(commit.sha)) {
		// `--root` makes the initial commit diff against the empty tree.
		return `git diff-tree -p --no-commit-id --root ${commit.sha}`;
	}
	if (mode === "branch" && branch && isSafeGitRef(branch)) {
		// Symmetric range: what this branch added since it diverged from `branch`.
		return `git diff ${branch}...HEAD`;
	}
	// "working" / default: uncommitted changes vs HEAD — what the agent's last
	// turn(s) touched.
	return "git diff HEAD";
}

function PatchDiffPanel({ folder }: { folder?: string | null }) {
	const [mode, setMode] = useState<DiffMode>("working");
	const [commit, setCommit] = useState<CommitInfo | null>(null);
	const [branch, setBranch] = useState<string | null>(null);
	const [commits, setCommits] = useState<CommitInfo[]>([]);
	const [branches, setBranches] = useState<string[]>([]);
	const [patch, setPatch] = useState("");
	const [loading, setLoading] = useState(false);
	const terminalShell = useWorkspaceStore((s) => s.terminalShell);

	const git = useCallback(
		async (command: string): Promise<string> => {
			if (!folder) {
				return "";
			}
			const shellArg = terminalShell === "auto" ? null : terminalShell;
			try {
				const r = await invoke<{
					stdout: string;
					stderr: string;
					code: number;
				}>("shell_execute", { command, cwd: folder, shell: shellArg });
				return r.stdout;
			} catch {
				return "";
			}
		},
		[folder, terminalShell]
	);

	// Populate the Commit / Branch sub-menus.
	useEffect(() => {
		if (!folder) {
			setCommits([]);
			setBranches([]);
			return;
		}
		git(`git log -n 50 --pretty=format:${GIT_LOG_FORMAT}`).then((out) => {
			const list: CommitInfo[] = [];
			for (const line of out.split("\n")) {
				const tab = line.indexOf("\t");
				if (tab > 0) {
					list.push({ sha: line.slice(0, tab), subject: line.slice(tab + 1) });
				}
			}
			setCommits(list);
		});
		git("git branch --format=%(refname:short)").then((out) => {
			setBranches(
				out
					.split("\n")
					.map((b) => b.trim())
					.filter(Boolean)
			);
		});
	}, [folder, git]);

	const refresh = useCallback(() => {
		if (!folder) {
			setPatch("");
			return;
		}
		setLoading(true);
		git(buildDiffCommand(mode, commit, branch))
			.then((out) => setPatch(out))
			.finally(() => setLoading(false));
	}, [folder, git, mode, commit, branch]);

	useEffect(() => {
		refresh();
	}, [refresh]);

	const modeLabel = (() => {
		if (mode === "staged") {
			return "Staged";
		}
		if (mode === "commit") {
			return commit ? `${shortSha(commit.sha)} ${commit.subject}` : "Commit";
		}
		if (mode === "branch") {
			return branch ? `${branch}…HEAD` : "Branch";
		}
		return "Last turn";
	})();

	if (!folder) {
		return (
			<div className="flex h-full items-center justify-center text-muted-foreground text-xs">
				No project folder open.
			</div>
		);
	}

	let body: ReactNode;
	if (loading) {
		body = (
			<div className="flex h-full animate-pulse items-center justify-center text-muted-foreground text-xs">
				Loading diff...
			</div>
		);
	} else if (patch.trim()) {
		body = <PatchDiff disableWorkerPool patch={patch} />;
	} else {
		body = (
			<div className="flex h-full items-center justify-center p-4 text-center text-muted-foreground text-xs">
				No changes for this selection.
			</div>
		);
	}

	return (
		<div className="flex h-full flex-col">
			{/* Diff source selector */}
			<div className="flex shrink-0 items-center gap-1 border-border/60 border-b bg-sidebar px-1.5 py-1">
				<DropdownMenu>
					<DropdownMenuTrigger className="flex min-w-0 max-w-full items-center gap-1.5 rounded-md px-2 py-1 text-muted-foreground text-xs transition-colors hover:bg-sidebar-accent hover:text-foreground">
						<HugeiconsIcon className="size-3.5 shrink-0" icon={FileCodeIcon} />
						<span className="truncate">{modeLabel}</span>
						<HugeiconsIcon
							className="size-3 shrink-0 opacity-60"
							icon={ArrowDown01Icon}
						/>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="start" side="bottom">
						<DropdownMenuItem
							className="text-xs"
							onClick={() => setMode("working")}
						>
							Last turn
						</DropdownMenuItem>
						<DropdownMenuItem
							className="text-xs"
							onClick={() => setMode("staged")}
						>
							Staged
						</DropdownMenuItem>
						<DropdownMenuSub>
							<DropdownMenuSubTrigger className="text-xs">
								Commit
							</DropdownMenuSubTrigger>
							<DropdownMenuSubContent className="max-h-[60vh] max-w-[360px] overflow-auto">
								{commits.length === 0 ? (
									<DropdownMenuItem
										className="text-muted-foreground text-xs"
										disabled
									>
										No commits
									</DropdownMenuItem>
								) : (
									commits.map((c) => (
										<DropdownMenuItem
											className="gap-2 text-xs"
											key={c.sha}
											onClick={() => {
												setCommit(c);
												setMode("commit");
											}}
										>
											<span className="shrink-0 font-mono text-[10px] opacity-60">
												{shortSha(c.sha)}
											</span>
											<span className="truncate">{c.subject}</span>
										</DropdownMenuItem>
									))
								)}
							</DropdownMenuSubContent>
						</DropdownMenuSub>
						<DropdownMenuSub>
							<DropdownMenuSubTrigger className="text-xs">
								Branch
							</DropdownMenuSubTrigger>
							<DropdownMenuSubContent className="max-h-[60vh] max-w-[360px] overflow-auto">
								{branches.length === 0 ? (
									<DropdownMenuItem
										className="text-muted-foreground text-xs"
										disabled
									>
										No branches
									</DropdownMenuItem>
								) : (
									branches.map((b) => (
										<DropdownMenuItem
											className="text-xs"
											key={b}
											onClick={() => {
												setBranch(b);
												setMode("branch");
											}}
										>
											{b}
										</DropdownMenuItem>
									))
								)}
							</DropdownMenuSubContent>
						</DropdownMenuSub>
					</DropdownMenuContent>
				</DropdownMenu>
				<div className="flex-1" />
				<Tooltip>
					<TooltipTrigger
						render={
							<button
								aria-label="Refresh diff"
								className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground"
								onClick={refresh}
								type="button"
							>
								<HugeiconsIcon
									className={cn("size-3.5", loading && "animate-spin")}
									icon={RefreshIcon}
								/>
							</button>
						}
					/>
					<TooltipContent>Refresh diff</TooltipContent>
				</Tooltip>
			</div>

			{/* Diff body (@pierre/diffs renders at content height and scrolls here) */}
			<div className="min-h-0 flex-1 overflow-auto">{body}</div>
		</div>
	);
}

// ── Iframe panel (browser tab) ────────────────────────────────────────────────

// Block Tauri's own origins so iframe scripts can never reach __TAURI__ APIs.
const BLOCKED_URL_RE = /^(tauri:|asset:|[a-z]+:\/\/tauri\.localhost)/i;

function IframePanel({
	initialUrl,
	title,
}: {
	initialUrl: string;
	title: string;
}) {
	const [src, setSrc] = useState(initialUrl);
	const [inputVal, setInputVal] = useState(initialUrl);

	const navigate = (raw: string) => {
		let url = raw.trim();
		if (!url) {
			return;
		}
		if (!URL_PROTOCOL_RE.test(url)) {
			url = `https://${url}`;
		}
		if (BLOCKED_URL_RE.test(url)) {
			return;
		}
		setSrc(url);
		setInputVal(url);
	};

	return (
		<div className="flex h-full flex-col">
			<SidebarContent className="shrink-0 border-border/60 border-b bg-sidebar px-2 py-1.5">
				<form
					className="flex items-center gap-2"
					onSubmit={(e) => {
						e.preventDefault();
						navigate(inputVal);
					}}
				>
					<HugeiconsIcon
						className="size-3.5 shrink-0 text-muted-foreground"
						icon={Globe02Icon}
					/>
					<input
						className="/60 min-w-0 flex-1 rounded-md bg-background px-2 py-0.5 text-xs outline-none focus:border-primary/60"
						onChange={(e) => setInputVal(e.target.value)}
						placeholder="Enter URL…"
						spellCheck={false}
						value={inputVal}
					/>
				</form>
			</SidebarContent>
			<iframe
				className="min-h-0 w-full flex-1 border-0 bg-white"
				key={src}
				sandbox="allow-scripts allow-forms allow-popups"
				src={src}
				title={title}
			/>
		</div>
	);
}

// ── Browser sidecar panel (com.ryu.browser) ───────────────────────────────────

const BROWSER_PLUGIN_ID = "com.ryu.browser";

interface SidecarTab {
	id: string;
	title: string;
	url: string;
}

// Feature-detected browser tab: when the `com.ryu.browser` app is enabled, drive its
// real-Chromium sidecar through Core's ext-proxy (tab list + open/navigate + a static
// screenshot preview — real embedding is a followup). When it is disabled, fall back
// to today's sandboxed IframePanel unchanged.
function BrowserTabPanel({ title }: { title: string }) {
	const { apps } = useApps();
	const enabled = apps.some((a) => a.id === BROWSER_PLUGIN_ID && a.enabled);
	if (enabled) {
		return <BrowserSidecarPanel />;
	}
	return <IframePanel initialUrl="https://www.google.com" title={title} />;
}

function BrowserSidecarPanel() {
	const node = useActiveNode();
	const [tabs, setTabs] = useState<SidecarTab[]>([]);
	const [activeId, setActiveId] = useState<string | null>(null);
	const [inputVal, setInputVal] = useState("");
	const [shot, setShot] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	const base = "/api/ext/com.ryu.browser";
	const headers = useMemo(() => makeHeaders(node.token ?? null), [node.token]);

	const call = useCallback(
		async (path: string, init?: RequestInit) => {
			const resp = await fetch(
				apiUrl({ url: node.url, token: node.token ?? null }, path),
				{
					headers,
					...init,
				}
			);
			if (!resp.ok) {
				throw new Error(`${resp.status}`);
			}
			return resp;
		},
		[node.url, node.token, headers]
	);

	const refresh = useCallback(async () => {
		setError(null);
		try {
			const resp = await call(`${base}/tabs`);
			const data = (await resp.json()) as { tabs: SidecarTab[] };
			setTabs(data.tabs);
			setActiveId((prev) => prev ?? data.tabs[0]?.id ?? null);
		} catch (e) {
			setError(
				e instanceof Error
					? `Browser sidecar unreachable (${e.message})`
					: "error"
			);
		}
	}, [call]);

	useEffect(() => {
		refresh().catch(() => undefined);
	}, [refresh]);

	const openTab = useCallback(
		async (raw: string) => {
			let url = raw.trim();
			if (!url) {
				return;
			}
			if (!URL_PROTOCOL_RE.test(url)) {
				url = `https://${url}`;
			}
			try {
				const resp = await call(`${base}/tabs`, {
					method: "POST",
					headers: { ...headers, "Content-Type": "application/json" },
					body: JSON.stringify({ url }),
				});
				const data = (await resp.json()) as { tab: SidecarTab };
				setActiveId(data.tab.id);
				setInputVal("");
				await refresh();
			} catch (e) {
				setError(e instanceof Error ? e.message : "open failed");
			}
		},
		[call, headers, refresh]
	);

	const screenshot = useCallback(
		async (id: string) => {
			try {
				const resp = await call(
					`${base}/tabs/${encodeURIComponent(id)}/screenshot`,
					{
						method: "POST",
					}
				);
				const data = (await resp.json()) as { image: string };
				setShot(`data:image/png;base64,${data.image}`);
			} catch (e) {
				setError(e instanceof Error ? e.message : "screenshot failed");
			}
		},
		[call]
	);

	const closeTab = useCallback(
		async (id: string) => {
			try {
				await call(`${base}/tabs/${encodeURIComponent(id)}`, {
					method: "DELETE",
				});
				setShot(null);
				setActiveId((prev) => (prev === id ? null : prev));
				await refresh();
			} catch (e) {
				setError(e instanceof Error ? e.message : "close failed");
			}
		},
		[call, refresh]
	);

	return (
		<div className="flex h-full flex-col">
			<SidebarContent className="shrink-0 border-border/60 border-b bg-sidebar px-2 py-1.5">
				<form
					className="flex items-center gap-2"
					onSubmit={(e) => {
						e.preventDefault();
						openTab(inputVal).catch(() => undefined);
					}}
				>
					<HugeiconsIcon
						className="size-3.5 shrink-0 text-muted-foreground"
						icon={Globe02Icon}
					/>
					<input
						className="min-w-0 flex-1 rounded-md bg-background px-2 py-0.5 text-xs outline-none focus:border-primary/60"
						onChange={(e) => setInputVal(e.target.value)}
						placeholder="Open a URL in the browser sidecar…"
						spellCheck={false}
						value={inputVal}
					/>
					<button
						className="rounded-md px-2 py-0.5 text-muted-foreground text-xs hover:bg-accent"
						onClick={() => refresh().catch(() => undefined)}
						type="button"
					>
						Refresh
					</button>
				</form>
			</SidebarContent>
			<div className="flex min-h-0 flex-1">
				<ul className="w-48 shrink-0 overflow-y-auto border-border/60 border-r text-xs">
					{tabs.length === 0 && (
						<li className="p-2 text-muted-foreground">No open tabs.</li>
					)}
					{tabs.map((t) => (
						<li
							className={cn(
								"flex items-center gap-1 border-border/40 border-b px-2 py-1.5",
								t.id === activeId && "bg-accent"
							)}
							key={t.id}
						>
							<button
								className="min-w-0 flex-1 truncate text-left"
								onClick={() => {
									setActiveId(t.id);
									screenshot(t.id).catch(() => undefined);
								}}
								title={t.url}
								type="button"
							>
								{t.title || t.url || t.id}
							</button>
							<button
								className="shrink-0 text-muted-foreground hover:text-foreground"
								onClick={() => closeTab(t.id).catch(() => undefined)}
								type="button"
							>
								×
							</button>
						</li>
					))}
				</ul>
				<div className="flex min-w-0 flex-1 items-center justify-center overflow-auto bg-muted/20 p-2">
					{error ? (
						<p className="text-center text-muted-foreground text-xs">{error}</p>
					) : shot ? (
						// biome-ignore lint/performance/noImgElement: sidecar screenshot data URI, not a static asset.
						<img
							alt="Browser tab preview"
							className="max-h-full max-w-full rounded border border-border/60"
							src={shot}
						/>
					) : (
						<p className="text-center text-muted-foreground text-xs">
							Select a tab to preview a screenshot. Live embedding is a
							followup.
						</p>
					)}
				</div>
			</div>
		</div>
	);
}

// ── Embedded terminal ─────────────────────────────────────────────────────────

interface TerminalLine {
	text: string;
	type: "prompt" | "output" | "error";
}

function SimpleTerminal({ cwd }: { cwd?: string | null }) {
	const [lines, setLines] = useState<TerminalLine[]>([
		{
			type: "output",
			text: cwd
				? `Terminal — ${cwd}\nType a command and press Enter.`
				: "Terminal\nType a command and press Enter.",
		},
	]);
	const [input, setInput] = useState("");
	const [running, setRunning] = useState(false);
	const [history, setHistory] = useState<string[]>([]);
	const [histIdx, setHistIdx] = useState(-1);
	const [currentCwd, setCurrentCwd] = useState(cwd ?? "");
	const terminalShell = useWorkspaceStore((s) => s.terminalShell);
	const outputRef = useRef<HTMLDivElement>(null);
	const inputRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		setCurrentCwd(cwd ?? "");
	}, [cwd]);

	useEffect(() => {
		if (outputRef.current) {
			outputRef.current.scrollTop = outputRef.current.scrollHeight;
		}
	}, []);

	const promptLabel = currentCwd
		? `${currentCwd.split(PATH_SEPARATOR_RE).at(-1) ?? currentCwd} $ `
		: "$ ";

	const runCommand = useCallback(
		async (cmd: string) => {
			if (!cmd.trim()) {
				setLines((prev) => [...prev, { type: "prompt", text: promptLabel }]);
				return;
			}
			setLines((prev) => [
				...prev,
				{ type: "prompt", text: `${promptLabel}${cmd}` },
			]);
			setRunning(true);
			const shellArg = terminalShell === "auto" ? null : terminalShell;
			try {
				const result = await invoke<{
					stdout: string;
					stderr: string;
					code: number;
				}>("shell_execute", {
					command: cmd,
					cwd: currentCwd || null,
					shell: shellArg,
				});
				const next: TerminalLine[] = [];
				if (result.stdout?.trim()) {
					next.push({ type: "output", text: result.stdout.trimEnd() });
				}
				if (result.stderr?.trim()) {
					next.push({ type: "error", text: result.stderr.trimEnd() });
				}
				setLines((prev) => [...prev, ...next]);
			} catch (e) {
				setLines((prev) => [...prev, { type: "error", text: String(e) }]);
			}
			setRunning(false);
		},
		[currentCwd, promptLabel, terminalShell]
	);

	const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
		if (e.key === "Enter") {
			const cmd = input.trim();
			if (cmd) {
				setHistory((prev) => [cmd, ...prev.slice(0, 99)]);
			}
			setHistIdx(-1);
			setInput("");
			runCommand(cmd);
		} else if (e.key === "ArrowUp") {
			e.preventDefault();
			const idx = Math.min(histIdx + 1, history.length - 1);
			setHistIdx(idx);
			if (idx >= 0) {
				setInput(history[idx]);
			}
		} else if (e.key === "ArrowDown") {
			e.preventDefault();
			const idx = Math.max(histIdx - 1, -1);
			setHistIdx(idx);
			setInput(idx >= 0 ? history[idx] : "");
		} else if (e.key === "l" && e.ctrlKey) {
			e.preventDefault();
			setLines([]);
		}
	};

	return (
		// biome-ignore lint/a11y/useKeyWithClickEvents: click-to-focus on a container is intentional
		<div
			className="flex h-full flex-col bg-sidebar text-sidebar-foreground"
			onClick={() => inputRef.current?.focus()}
			style={{ fontFamily: "var(--font-code)" }}
		>
			<div
				className="min-h-0 flex-1 overflow-auto p-2 font-mono text-[12.5px] leading-[1.55]"
				ref={outputRef}
			>
				{lines.map((line, i) => {
					let lineClassName = "text-foreground";
					if (line.type === "prompt") {
						lineClassName = "text-primary";
					} else if (line.type === "error") {
						lineClassName = "text-destructive";
					}
					return (
						// biome-ignore lint/suspicious/noArrayIndexKey: stable sequential terminal lines
						<div className={lineClassName} key={i}>
							<pre className="whitespace-pre-wrap font-mono">
								{line.text || " "}
							</pre>
						</div>
					);
				})}
				{running && (
					<div className="animate-pulse font-mono text-[12.5px] text-muted-foreground">
						...
					</div>
				)}
			</div>
			<div className="flex shrink-0 items-center px-2 py-1.5 font-mono text-[12.5px]">
				<span className="mr-1.5 shrink-0 select-none text-primary">
					{promptLabel}
				</span>
				<input
					autoCapitalize="none"
					autoComplete="off"
					autoFocus
					className="min-w-0 flex-1 bg-transparent font-mono text-foreground caret-foreground outline-none"
					disabled={running}
					onChange={(e) => setInput(e.target.value)}
					onKeyDown={handleKeyDown}
					ref={inputRef}
					spellCheck={false}
					value={input}
				/>
			</div>
		</div>
	);
}

// ── Panel content renderer ────────────────────────────────────────────────────

/** Chat-specific data for the Context (cowork) tab, threaded from ChatPage. */
type CoworkData = CoworkContextPanelProps;

/** The subagent whose transcript the right panel is currently showing. */
export interface SubagentView {
	id: string;
	label: string;
}

// The clicked subagent's chat, rebuilt live from the run's message stream (so a
// still-running subagent's steps keep streaming in) and rendered read-only with
// the same MessageList as the main transcript.
function SubagentTranscriptPanel({
	cowork,
	view,
}: {
	cowork?: CoworkData;
	view: SubagentView | null;
}) {
	const subagents = useMemo(
		() => extractSubagents(cowork?.messages ?? []),
		[cowork?.messages]
	);
	const active = view ? subagents.find((s) => s.id === view.id) : undefined;

	if (!active) {
		return (
			<div className="flex h-full items-center justify-center p-4 text-center text-muted-foreground text-xs">
				This subagent's activity is no longer available.
			</div>
		);
	}

	return (
		<div className="flex h-full flex-col">
			<div className="flex shrink-0 items-center gap-2 border-border/60 border-b px-3 py-2">
				<SubagentAvatar className="size-7" seed={active.id} />
				<div className="min-w-0 flex-1">
					<div className="flex items-center gap-1.5">
						<span className="truncate font-medium text-foreground text-sm">
							{active.name}
						</span>
						<span className="shrink-0 truncate text-muted-foreground/70 text-xs">
							{active.label}
						</span>
					</div>
					{active.subtitle && (
						<div className="truncate text-muted-foreground text-xs">
							{active.subtitle}
						</div>
					)}
				</div>
			</div>
			<div className="min-h-0 flex-1 overflow-hidden">
				<MessageList
					initialScrollBehavior="top"
					messages={active.transcript}
					status="ready"
				/>
			</div>
		</div>
	);
}

function TabContent({
	tab,
	folder,
	cowork,
	subagentView,
	artifactView,
	inspectorView,
}: {
	artifactView?: Artifact | null;
	cowork?: CoworkData;
	folder?: string | null;
	inspectorView?: InspectedPart | null;
	subagentView?: SubagentView | null;
	tab: PanelTab;
}) {
	if (tab.kind === "terminal") {
		return <SimpleTerminal cwd={folder} />;
	}
	if (tab.kind === "inspector") {
		if (inspectorView == null) {
			return (
				<div className="flex h-full items-center justify-center p-4 text-center text-muted-foreground text-xs">
					This part is no longer available.
				</div>
			);
		}
		return <PartInspector part={inspectorView} />;
	}
	if (tab.kind === "subagent") {
		return (
			<SubagentTranscriptPanel cowork={cowork} view={subagentView ?? null} />
		);
	}
	if (tab.kind === "artifact") {
		if (!artifactView) {
			return (
				<div className="flex h-full items-center justify-center p-4 text-center text-muted-foreground text-xs">
					This artifact is no longer available.
				</div>
			);
		}
		return <ArtifactRenderer artifact={artifactView} />;
	}
	if (tab.kind === "codereview") {
		return <PatchDiffPanel folder={folder} key={`${tab.uid}-${folder}`} />;
	}
	if (tab.kind === "files") {
		return <FileTreePanel folder={folder} key={`${tab.uid}-${folder}`} />;
	}
	if (tab.kind === "cowork") {
		// Outside a chat (no cowork data) there is nothing to summarise.
		if (!cowork) {
			return (
				<div className="flex h-full items-center justify-center p-4 text-center text-muted-foreground text-xs">
					Open a chat to see its context here.
				</div>
			);
		}
		return <CoworkContextPanel {...cowork} />;
	}
	return <BrowserTabPanel title={tab.label} />;
}

// ── Drag resize hook ──────────────────────────────────────────────────────────

function useResizeHandle(
	direction: "vertical" | "horizontal",
	setSize: (updater: (prev: number) => number) => void
) {
	const resizing = useRef(false);
	const startPos = useRef(0);
	const startSize = useRef(0);
	// Exposed so callers can suppress the open/close transition while dragging,
	// otherwise the size transition fights the live drag and feels laggy.
	const [isResizing, setIsResizing] = useState(false);

	const onMouseDown = useCallback(
		(e: ReactMouseEvent, currentSize: number) => {
			e.preventDefault();
			resizing.current = true;
			setIsResizing(true);
			startPos.current = direction === "vertical" ? e.clientY : e.clientX;
			startSize.current = currentSize;
			document.body.style.cursor =
				direction === "vertical" ? "row-resize" : "col-resize";
			document.body.style.userSelect = "none";
		},
		[direction]
	);

	useEffect(() => {
		const onMove = (e: MouseEvent) => {
			if (!resizing.current) {
				return;
			}
			const pos = direction === "vertical" ? e.clientY : e.clientX;
			const delta = startPos.current - pos;
			setSize(() => Math.max(80, Math.min(800, startSize.current + delta)));
		};
		const onUp = () => {
			if (!resizing.current) {
				return;
			}
			resizing.current = false;
			setIsResizing(false);
			document.body.style.cursor = "";
			document.body.style.userSelect = "";
		};
		document.addEventListener("mousemove", onMove, { passive: true });
		document.addEventListener("mouseup", onUp);
		return () => {
			document.removeEventListener("mousemove", onMove);
			document.removeEventListener("mouseup", onUp);
		};
	}, [direction, setSize]);

	return { onMouseDown, isResizing };
}

// ── Panel toggle buttons ──────────────────────────────────────────────────────

export interface PanelToggleButtonsProps {
	bottomOpen: boolean;
	folder?: string | null;
	onBottomToggle: () => void;
	onPinnedSummaryToggle?: () => void;
	onRightToggle: () => void;
	/** Pinned summary toggle — omitted (no button) when the pair isn't provided. */
	pinnedSummaryOpen?: boolean;
	rightOpen: boolean;
}

export function PanelToggleButtons({
	bottomOpen,
	onBottomToggle,
	rightOpen,
	onRightToggle,
	folder,
	pinnedSummaryOpen,
	onPinnedSummaryToggle,
}: PanelToggleButtonsProps) {
	return (
		<>
			{folder ? (
				<>
					<EditorButtonGroup folder={folder} />
					<div className="h-4 w-px bg-border/60" />
				</>
			) : null}
			{onPinnedSummaryToggle ? (
				<Tooltip>
					<TooltipTrigger
						render={
							<button
								className={cn(
									"flex size-8 shrink-0 items-center justify-center rounded-xl transition-colors hover:bg-muted hover:text-foreground",
									pinnedSummaryOpen
										? "text-foreground"
										: "text-muted-foreground"
								)}
								onClick={onPinnedSummaryToggle}
								type="button"
							>
								<HugeiconsIcon className="size-4" icon={CheckListIcon} />
							</button>
						}
					/>
					<TooltipContent>{`${pinnedSummaryOpen ? "Hide" : "Show"} pinned summary`}</TooltipContent>
				</Tooltip>
			) : null}
			<Tooltip>
				<TooltipTrigger
					render={
						<button
							className="flex size-8 shrink-0 items-center justify-center rounded-xl text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
							onClick={onBottomToggle}
							type="button"
						>
							{bottomOpen ? (
								<BottomPanelIconOpen className="size-4" />
							) : (
								<BottomPanelIconClosed className="size-4" />
							)}
						</button>
					}
				/>
				<TooltipContent>{`${bottomOpen ? "Hide" : "Show"} bottom panel`}</TooltipContent>
			</Tooltip>
			<Tooltip>
				<TooltipTrigger
					render={
						<button
							className="flex size-8 shrink-0 items-center justify-center rounded-xl text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
							onClick={onRightToggle}
							type="button"
						>
							{rightOpen ? (
								<RightPanelIconOpen className="size-4" />
							) : (
								<RightPanelIconClosed className="size-4" />
							)}
						</button>
					}
				/>
				<TooltipContent>{`${rightOpen ? "Hide" : "Show"} right panel`}</TooltipContent>
			</Tooltip>
		</>
	);
}

// ── Main WorkspacePanels component ────────────────────────────────────────────

export interface WorkspacePanelsProps {
	/**
	 * A request to open a rendered/canvas artifact in the right panel. Like
	 * `subagentRequest`, the `nonce` changes on every click so re-selecting the
	 * same artifact re-focuses the tab. Null when nothing has been requested.
	 */
	artifactRequest?: { artifact: Artifact; nonce: number } | null;
	bottomOpen: boolean;
	children: ReactNode;
	/** Chat-specific data for the Context (cowork) right-panel tab. */
	cowork?: CoworkData;
	folder?: string | null;
	/**
	 * A request to inspect a raw message part (tool call / image / citations) in
	 * the right panel's PartInspector. Like `artifactRequest`, the `nonce` changes
	 * on every click so re-inspecting refreshes the same reusable tab. Null when
	 * nothing has been requested.
	 */
	inspectorRequest?: { part: InspectedPart; nonce: number } | null;
	onBottomOpenChange: (v: boolean) => void;
	onRightOpenChange: (v: boolean) => void;
	rightOpen: boolean;
	/**
	 * A request to open a spawned subagent's transcript in the right panel. Its
	 * `nonce` changes on every click so re-selecting the same subagent re-focuses
	 * the tab. Null when nothing has been requested.
	 */
	subagentRequest?: { id: string; label: string; nonce: number } | null;
}

// How long the hover-peek stays after the pointer leaves (matches the left sidebar).
const PEEK_HIDE_DELAY = 200;

export function WorkspacePanels({
	children,
	folder,
	cowork,
	bottomOpen,
	onBottomOpenChange,
	rightOpen,
	onRightOpenChange,
	subagentRequest,
	artifactRequest,
	inspectorRequest,
}: WorkspacePanelsProps) {
	// Both docks start with no tabs open: a docked panel shows the launchpad empty
	// state (openable tab types as quick actions) rather than pre-opening tabs the
	// user didn't ask for. Tabs are added on demand and closable back down to zero.
	const bottom = usePanelTabs([]);
	const right = usePanelTabs([]);
	// The subagent currently pinned to the right panel's subagent tab (if any).
	const [subagentView, setSubagentView] = useState<SubagentView | null>(null);
	// The artifact currently pinned to the right panel's artifact tab (if any).
	const [artifactView, setArtifactView] = useState<Artifact | null>(null);
	// The raw message part currently pinned to the right panel's inspector tab.
	const [inspectorView, setInspectorView] = useState<InspectedPart | null>(
		null
	);

	// Open (or re-focus) the subagent tab when ChatPage requests one. `openTab` is
	// re-created each render, so hold it in a ref and depend only on the request —
	// the effect fires once per click (the nonce makes each request distinct).
	const openRightTabRef = useRef(right.openTab);
	openRightTabRef.current = right.openTab;
	useEffect(() => {
		if (!subagentRequest) {
			return;
		}
		setSubagentView({ id: subagentRequest.id, label: subagentRequest.label });
		openRightTabRef.current("subagent", subagentRequest.label);
	}, [subagentRequest]);

	// Same one-tab-reuse + nonce-refocus flow for rendered/canvas artifacts.
	useEffect(() => {
		if (!artifactRequest) {
			return;
		}
		setArtifactView(artifactRequest.artifact);
		openRightTabRef.current("artifact", artifactRequest.artifact.title);
	}, [artifactRequest]);

	// Same one-tab-reuse + nonce-refocus flow for the raw part inspector. The
	// inspector lives in its OWN reusable tab, so opening it never clobbers the
	// artifact/subagent tabs (they simply sit alongside it — no fight over one
	// shared right-panel slot).
	useEffect(() => {
		if (!inspectorRequest) {
			return;
		}
		setInspectorView(inspectorRequest.part);
		openRightTabRef.current("inspector", "Inspector");
	}, [inspectorRequest]);
	const [bottomHeight, setBottomHeight] = useState(260);
	const [rightWidth, setRightWidth] = useState(340);

	const { onMouseDown: resizeBottom, isResizing: bottomResizing } =
		useResizeHandle("vertical", setBottomHeight);
	const { onMouseDown: resizeRight, isResizing: rightResizing } =
		useResizeHandle("horizontal", setRightWidth);

	// Slide/ease used when docking or undocking a panel. Suppressed mid-drag so
	// the resize stays 1:1 with the pointer.
	const DOCK_EASE = "cubic-bezier(0.32, 0.72, 0, 1)";

	// Hover-peek: when a panel is closed (undocked), hovering its edge slides a
	// floating copy in; it auto-hides shortly after the pointer leaves. Mirrors
	// the left sidebar's floating-on-hover behaviour from Layout.tsx.
	const [rightPeek, setRightPeek] = useState(false);
	const rightHideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	const showRightPeek = () => {
		if (rightHideTimer.current) {
			clearTimeout(rightHideTimer.current);
		}
		rightHideTimer.current = null;
		setRightPeek(true);
	};
	const hideRightPeek = () => {
		if (rightHideTimer.current) {
			clearTimeout(rightHideTimer.current);
		}
		rightHideTimer.current = setTimeout(
			() => setRightPeek(false),
			PEEK_HIDE_DELAY
		);
	};

	// Drop any pending peek when the panel becomes docked.
	useEffect(() => {
		if (rightOpen) {
			setRightPeek(false);
		}
	}, [rightOpen]);

	const activeBottomTab = bottom.tabs.find((t) => t.uid === bottom.activeUid);
	const activeRightTab = right.tabs.find((t) => t.uid === right.activeUid);

	// ── Reusable panel cards (shared by docked + floating-peek renders) ──────────

	const addBottomTab = (kind: TabKind) =>
		bottom.addTab(
			kind,
			BOTTOM_TAB_TYPES.find((t) => t.kind === kind)?.label ?? kind
		);
	const addRightTab = (kind: TabKind) =>
		right.addTab(
			kind,
			RIGHT_TAB_TYPES.find((t) => t.kind === kind)?.label ?? kind
		);

	const bottomCard = (onClosePanel: () => void) => (
		<div className="mx-2 mb-2 flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl bg-sidebar shadow-2xl ring-1 ring-border/40">
			<PanelTabBar
				activeUid={bottom.activeUid}
				addTypes={BOTTOM_TAB_TYPES}
				onActivate={bottom.setActiveUid}
				onAdd={addBottomTab}
				onClosePanel={onClosePanel}
				onCloseTab={bottom.closeTab}
				tabs={bottom.tabs}
			/>
			<div className="min-h-0 flex-1 overflow-hidden">
				{activeBottomTab ? (
					<TabContent folder={folder} tab={activeBottomTab} />
				) : (
					<PanelEmptyState addTypes={BOTTOM_TAB_TYPES} onAdd={addBottomTab} />
				)}
			</div>
		</div>
	);

	const rightCard = (onClosePanel: () => void) => (
		<div className="my-2 mr-2 flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl bg-sidebar shadow-2xl ring-1 ring-border/40">
			<PanelTabBar
				activeUid={right.activeUid}
				addTypes={RIGHT_TAB_TYPES}
				onActivate={right.setActiveUid}
				onAdd={addRightTab}
				onClosePanel={onClosePanel}
				onCloseTab={right.closeTab}
				tabs={right.tabs}
			/>
			<div className="min-h-0 flex-1 overflow-hidden">
				{activeRightTab ? (
					<TabContent
						artifactView={artifactView}
						cowork={cowork}
						folder={folder}
						inspectorView={inspectorView}
						subagentView={subagentView}
						tab={activeRightTab}
					/>
				) : (
					<PanelEmptyState addTypes={RIGHT_TAB_TYPES} onAdd={addRightTab} />
				)}
			</div>
		</div>
	);

	const bottomResizeHandle = (
		<div
			className="group flex h-3 w-full shrink-0 cursor-row-resize items-center justify-center"
			onMouseDown={(e) => resizeBottom(e, bottomHeight)}
		>
			<div className="h-[3px] w-10 rounded-full bg-border/50 opacity-0 transition-opacity group-hover:opacity-100" />
		</div>
	);

	const rightResizeHandle = (
		<div
			className="group flex h-full w-3 shrink-0 cursor-col-resize items-center justify-center"
			onMouseDown={(e) => resizeRight(e, rightWidth)}
		>
			<div className="h-10 w-[3px] rounded-full bg-border/50 opacity-0 transition-opacity group-hover:opacity-100" />
		</div>
	);

	// A panel is visible when docked open OR being hover-peeked while closed. The
	// docked state also drives an in-flow spacer that pushes the chat (shadcn's
	// sidebar approach: one fixed panel + an animated gap), so the single mounted
	// panel slides for both the toggle and the peek — no duplicate instances, no
	// snap.
	const rightVisible = rightOpen || rightPeek;
	const closeBottom = () => {
		onBottomOpenChange(false);
	};
	const closeRight = () => {
		onRightOpenChange(false);
		setRightPeek(false);
	};

	return (
		// Outer row: [ chat column (+ bottom panel) ] [ right spacer ] · right panel floats on the edge
		<div className="relative flex h-full overflow-hidden">
			{/* Chat column — shrinks when the bottom/right panels are docked */}
			<div className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
				<div className="min-h-0 flex-1 overflow-hidden">{children}</div>

				{/* In-flow spacer: animates the chat's height when the bottom panel docks */}
				<div
					className="shrink-0"
					style={{
						height: bottomOpen ? bottomHeight + 12 : 0,
						transition: bottomResizing ? "none" : `height 300ms ${DOCK_EASE}`,
					}}
				/>

				{/* The one bottom-panel instance — pinned to the bottom edge. It has no
				    hover-peek and stays hidden until the toolbar toggle opens it. Closed
				    means display:none (fully out of layout) rather than an off-screen
				    transform: translateY(100%) only clears the viewport once the column
				    has reached full height, so on first mount the panel would otherwise
				    flash visible until a later reflow. */}
				<div
					className="absolute inset-x-0 bottom-0 z-20 flex flex-col"
					style={{
						height: bottomHeight + 12,
						display: bottomOpen ? "flex" : "none",
					}}
				>
					{bottomResizeHandle}
					{bottomCard(closeBottom)}
				</div>
			</div>

			{/* In-flow spacer: animates the chat's width when the right panel docks */}
			<div
				className="shrink-0"
				style={{
					width: rightOpen ? rightWidth + 12 : 0,
					transition: rightResizing ? "none" : `width 300ms ${DOCK_EASE}`,
				}}
			/>

			{/* The one right-panel instance — pinned to the right edge, slides via
			    transform for both docking and hover-peek. It starts BELOW the frosted
			    titlebar (top-12 = the bar's h-12) so the full-width bar keeps its
			    right-side panel-toggle buttons visible and clickable while the panel
			    is open — otherwise this z-20 layer covers the z-10 titlebar and you
			    can no longer reach the button that hides it. */}
			<div
				className="absolute top-12 right-0 bottom-0 z-20 flex flex-row"
				onMouseEnter={rightOpen ? undefined : showRightPeek}
				onMouseLeave={rightOpen ? undefined : hideRightPeek}
				style={{
					width: rightWidth + 12,
					transform: rightVisible ? "translateX(0)" : "translateX(100%)",
					pointerEvents: rightVisible ? "auto" : "none",
					transition: rightResizing ? "none" : `transform 300ms ${DOCK_EASE}`,
				}}
			>
				{rightResizeHandle}
				{rightCard(closeRight)}
			</div>

			{/* Right edge hover-zone: reveals the peek while the panel is closed.
			    Starts below the titlebar so its z-30 strip never sits over the bar's
			    right-side action buttons. */}
			{!rightOpen && (
				<div
					className="absolute top-12 right-0 bottom-0 z-30 w-2"
					onMouseEnter={showRightPeek}
					onMouseLeave={hideRightPeek}
				/>
			)}
		</div>
	);
}
