import {
	ArrowDown01Icon,
	ComputerTerminal01Icon,
	FolderOpenIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@ryu/ui/components/dropdown-menu.tsx";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip.tsx";
import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import { invoke } from "@tauri-apps/api/core";
import { useTheme } from "next-themes";
import { useEffect, useMemo, useState } from "react";
import { useAppSurface } from "@/src/contexts/app-surface-context.tsx";
import { useTerminalPanelLocation } from "@/src/hooks/useTerminalPanelLocation.ts";
import type { DefaultFileOpener } from "@/src/lib/default-file-opener.ts";
import { useDockPanelRequestStore } from "@/src/store/useDockPanelRequestStore.ts";
import { useWorkspaceStore } from "@/src/store/useWorkspaceStore.ts";

// ── Editor open buttons (split button group with chevron) ─────────────────────

// An icon source is either a single asset or a light/dark themed pair.
type SvglSlug = string | { dark: string; light: string };

// Inline glyphs rendered with `currentColor` so they follow the toolbar text
// colour in both light and dark themes. (An external SVG loaded via <img> cannot
// inherit `currentColor`, so monochrome brand marks must be inlined, not <img>'d.)
type EditorGlyph = "terminal" | "windows-terminal" | "cmd" | "folder";

export interface EditorDef {
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
export let fileManagerName = "Files";
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

export const EDITOR_DEFS: EditorDef[] = [
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

export const SHELL_EDITOR_IDS = new Set([
	"terminal",
	"gitbash",
	"powershell",
	"cmd",
]);

function editorIdForDefaultFileOpener(opener: DefaultFileOpener): string {
	return opener === "system" ? "explorer" : opener;
}

function defaultFileOpenerForEditorId(id: string): DefaultFileOpener | null {
	if (id === "explorer") {
		return "system";
	}
	if (id === "vscode" || id === "cursor" || id === "zed") {
		return id;
	}
	return null;
}

export function useAvailableEditorIds(enabled = true): Set<string> {
	const [availableEditorIds, setAvailableEditorIds] = useState<Set<string>>(
		() => new Set(["explorer"])
	);

	useEffect(() => {
		if (!enabled) {
			return;
		}
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
			})
			.catch(() => {
				if (!cancelled) {
					setAvailableEditorIds(new Set(["explorer"]));
				}
			});

		return () => {
			cancelled = true;
		};
	}, [enabled]);

	return availableEditorIds;
}

const WINDOWS_TERMINAL_PATH =
	"M8.165 6V3h7.665v3H8.165zm-.5-3H1c-.55 0-1 .45-1 1v2h7.665V3zM23 3h-6.67v3H24V4c0-.55-.45-1-1-1zM0 6.5h24V20c0 .55-.45 1-1 1H1c-.55 0-1-.45-1-1V6.5zM11.5 18c0 .3.2.5.5.5h8c.3 0 .5-.2.5-.5v-1.5c0-.3-.2-.5-.5-.5h-8c-.3 0-.5.2-.5.5V18zm-5.2-4.55l-3.1 3.1c-.25.25-.25.6 0 .8l.9.9c.25.25.6.25.8 0l4.4-4.4a.52.52 0 0 0 0-.8l-4.4-4.4c-.2-.2-.6-.2-.8 0l-.9.9c-.25.2-.25.55 0 .8l3.1 3.1z";
const CMD_PATH =
	"M12.5 1h-9A2.5 2.5 0 0 0 1 3.5v9A2.5 2.5 0 0 0 3.5 15h9a2.5 2.5 0 0 0 2.5-2.5v-9A2.5 2.5 0 0 0 12.5 1M14 12.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 12.5V5h12zM14 4H2v-.5A1.5 1.5 0 0 1 3.5 2h9A1.5 1.5 0 0 1 14 3.5zM4 10.508v-2c0-.827.673-1.5 1.5-1.5s1.5.673 1.5 1.5a.5.5 0 0 1-1 0a.5.5 0 0 0-1 0v2a.5.5 0 0 0 1 0a.5.5 0 0 1 1 0c0 .827-.673 1.5-1.5 1.5s-1.5-.673-1.5-1.5M8 8.5a.5.5 0 1 1 1 0a.5.5 0 0 1-1 0m0 2a.5.5 0 1 1 1 0a.5.5 0 0 1-1 0m1.532-2.824a.5.5 0 0 1 .292-.644a.5.5 0 0 1 .644.292l1.5 4A.5.5 0 0 1 11.5 12a.5.5 0 0 1-.468-.324z";

function GlyphIcon({ glyph }: { glyph: EditorGlyph }) {
	if (glyph === "windows-terminal") {
		return (
			<svg
				aria-hidden="true"
				className="size-4 shrink-0"
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
				className="size-4 shrink-0"
				fill="currentColor"
				viewBox="0 0 16 16"
			>
				<path d={CMD_PATH} />
			</svg>
		);
	}
	if (glyph === "terminal") {
		return <HugeiconsIcon className="size-4" icon={ComputerTerminal01Icon} />;
	}
	return <HugeiconsIcon className="size-4" icon={FolderOpenIcon} />;
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
	const resolved = isNativeText(spec)
		? spec
		: resolvedTheme === "dark"
			? spec.dark
			: spec.light;
	if (failed) {
		return <GlyphIcon glyph={glyph} />;
	}
	return (
		<img
			alt={label}
			className="size-4 shrink-0 object-contain"
			// Re-fetch (and reset the fallback) when the themed variant changes.
			key={resolved}
			onError={() => setFailed(true)}
			src={resolveUrl(resolved)}
		/>
	);
}

export function EditorIcon({ def }: { def: EditorDef }) {
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

export function EditorButtonGroup({ folder }: { folder?: string | null }) {
	const tl = useLiteralMessages();
	const { canUseNativeShell } = useAppSurface();
	const [terminalPanelLocation] = useTerminalPanelLocation();
	const defaultFileOpener = useWorkspaceStore((s) => s.defaultFileOpener);
	const setDefaultFileOpener = useWorkspaceStore((s) => s.setDefaultFileOpener);
	const [activeId, setActiveId] = useState(() =>
		editorIdForDefaultFileOpener(defaultFileOpener)
	);
	const availableEditorIds = useAvailableEditorIds(canUseNativeShell);
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
		const preferredId = editorIdForDefaultFileOpener(defaultFileOpener);
		setActiveId(availableEditorIds.has(preferredId) ? preferredId : "explorer");
	}, [availableEditorIds, defaultFileOpener]);

	if (!canUseNativeShell) {
		return null;
	}

	const run = async (id: string) => {
		setActiveId(id);
		if (id === "terminal") {
			useDockPanelRequestStore
				.getState()
				.open("terminal", "Terminal", terminalPanelLocation);
			return;
		}
		const opener = defaultFileOpenerForEditorId(id);
		if (opener) {
			setDefaultFileOpener(opener);
		}
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
						<Button
							aria-label={tl("Open in {label}", { label: activeDef.label })}
							onClick={() => run(activeDef.id)}
							size="icon-sm"
							variant="ghost-muted"
						>
							<EditorIcon def={activeDef} />
						</Button>
					}
				/>
				<TooltipContent>{`${activeDef.label}${folder ? `: ${folder}` : ""}`}</TooltipContent>
			</Tooltip>
			<DropdownMenu>
				<DropdownMenuTrigger
					aria-label="Choose editor"
					className="flex h-8 items-center"
					variant="panel-picker"
				>
					<HugeiconsIcon className="size-3.5" icon={ArrowDown01Icon} />
				</DropdownMenuTrigger>
				<DropdownMenuContent align="start" side="bottom">
					{editorDefs.map((def) => (
						<DropdownMenuItem
							density="compact"
							key={def.id}
							onClick={() => run(def.id)}
							spacing="spacious"
							tone={def.id === activeId ? "foreground" : "muted"}
						>
							<EditorIcon def={def} />
							{def.shortLabel}
							{def.id === activeId && (
								<span className="ml-auto text-muted-foreground text-xs">
									active
								</span>
							)}
						</DropdownMenuItem>
					))}
				</DropdownMenuContent>
			</DropdownMenu>
		</div>
	);
}
