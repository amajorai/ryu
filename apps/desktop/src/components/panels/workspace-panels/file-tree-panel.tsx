import { Search01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { toast } from "@ryu/ui/components/sileo.tsx";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FileAnnotationViewer } from "@/src/components/panels/FileAnnotationViewer.tsx";
import { useAppSurface } from "@/src/contexts/app-surface-context.tsx";
import {
	fileTreePrefsToOptions,
	setFileTreePrefs,
	useFileTreePrefs,
} from "@/src/hooks/useFileTreePrefs.ts";
import { useFileTreeThemeStyles } from "@/src/hooks/useFileTreeThemeStyles.ts";
import type { PluginFileHandler } from "@/src/lib/api/plugins.ts";
import type { FileAnnotationNote } from "@/src/lib/file-annotations.ts";
import { useFileTreeSearchStore } from "@/src/store/useFileTreeSearchStore.ts";
import { useWorkspaceStore } from "@/src/store/useWorkspaceStore.ts";
import { PluginFilePanel } from "../PluginFilePanel.tsx";
import { EDITOR_DEFS, useAvailableEditorIds } from "./editor-buttons.tsx";
import { FileTreeView } from "./file-tree-view.tsx";

// ── File tree panel (@pierre/trees) ──────────────────────────────────────────

export function FileTreePanel({
	active = true,
	folder,
}: {
	active?: boolean;
	folder?: string | null;
}) {
	const { canUseNativeShell } = useAppSurface();
	const [paths, setPaths] = useState<readonly string[]>([]);
	const scopeRef = useRef({ folder, native: canUseNativeShell });
	const pendingMoveRef = useRef<typeof scopeRef.current | null>(null);
	const mountedRef = useRef(false);
	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
		};
	}, []);
	if (
		scopeRef.current.folder !== folder ||
		scopeRef.current.native !== canUseNativeShell
	) {
		scopeRef.current = { folder, native: canUseNativeShell };
	}
	const operationScope = scopeRef.current;
	const resolvedListingScopeRef = useRef<typeof operationScope | null>(null);
	const canMoveItem = useCallback(() => {
		const scope = operationScope;
		return Boolean(
			mountedRef.current &&
				scopeRef.current === scope &&
				scope.native &&
				scope.folder &&
				pendingMoveRef.current !== scope
		);
	}, [operationScope]);
	const moveItems = useCallback(
		async (
			items: readonly { sourcePath: string; destinationPath: string }[]
		) => {
			const scope = operationScope;
			if (!(canMoveItem() && scope.folder) || items.length === 0) {
				return;
			}
			pendingMoveRef.current = scope;
			const refused: string[] = [];
			try {
				for (const item of items) {
					// Do not start another write after the owning panel loses authority.
					if (!mountedRef.current || scopeRef.current !== scope) {
						break;
					}
					const sourcePath = item.sourcePath.replace(/\/+$/, "");
					const destinationPath = item.destinationPath.replace(/\/+$/, "");
					if (sourcePath === destinationPath) {
						continue;
					}
					try {
						await invoke("move_workspace_item", {
							root: scope.folder,
							sourcePath,
							destinationPath,
						});
					} catch (error) {
						const message =
							error instanceof Error ? error.message : String(error);
						refused.push(
							items.length === 1 ? message : `${sourcePath}: ${message}`
						);
					}
				}
				if (
					refused.length &&
					mountedRef.current &&
					scopeRef.current === scope
				) {
					toast.error("Couldn't move that workspace item", {
						description: refused.join("\n"),
					});
				}
			} finally {
				if (pendingMoveRef.current === scope) {
					pendingMoveRef.current = null;
				}
				// Each move is exclusive independently. Successful items remain moved
				// after another item's refusal; replace all optimistic model changes
				// with the actual filesystem, including any partial result.
				if (mountedRef.current && scopeRef.current === scope) {
					setListingAttempt((attempt) => attempt + 1);
				}
			}
		},
		[operationScope, canMoveItem]
	);
	const moveItem = useCallback(
		(sourcePath: string, destinationPath: string) =>
			moveItems([{ sourcePath, destinationPath }]),
		[moveItems]
	);
	const [loading, setLoading] = useState(false);
	const [listingError, setListingError] = useState<string | null>(null);
	const [listingAttempt, setListingAttempt] = useState(0);
	const [pluginFile, setPluginFile] = useState<{
		path: string;
		handler: PluginFileHandler;
	} | null>(null);
	// Workspace-relative path shown in the annotation viewer. Notes are kept per
	// path for the panel's lifetime so "Back to files" does not discard them.
	const [viewerPath, setViewerPath] = useState<string | null>(null);
	const [notesByPath, setNotesByPath] = useState<
		Readonly<Record<string, FileAnnotationNote[]>>
	>({});
	const defaultFileOpener = useWorkspaceStore((s) => s.defaultFileOpener);
	const searchRequest = useFileTreeSearchStore((state) =>
		active ? state.request : null
	);

	useEffect(() => {
		let cancelled = false;
		setListingError(null);
		if (!(folder && canUseNativeShell)) {
			setPaths([]);
			setLoading(false);
			return;
		}
		setLoading(true);
		// Native listing filters physically absent cached git entries and returns
		// JSON paths, preserving filenames containing newlines without shell parsing.
		invoke<string[]>("list_workspace_files", { root: folder })
			.then((result) => {
				if (!cancelled) {
					resolvedListingScopeRef.current = operationScope;
					setPaths(result);
				}
			})
			.catch((error) => {
				if (!cancelled) {
					setPaths([]);
					setListingError(
						error instanceof Error ? error.message : String(error)
					);
				}
			})
			.finally(() => {
				if (!cancelled) {
					setLoading(false);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [folder, canUseNativeShell, listingAttempt, operationScope]);

	const prefs = useFileTreePrefs();
	const searchEnabled = prefs.showSearch || searchRequest !== null;
	const options = useMemo(
		() =>
			fileTreePrefsToOptions({
				...prefs,
				showSearch: searchEnabled,
				renaming: prefs.renaming && canUseNativeShell,
				dragAndDrop: prefs.dragAndDrop && canUseNativeShell,
			}),
		[prefs, searchEnabled, canUseNativeShell]
	);
	const themeStyles = useFileTreeThemeStyles(prefs);
	const treeThemeHost = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const host = treeThemeHost.current;
		if (!(host && themeStyles)) {
			return;
		}
		const keys: string[] = [];
		for (const [key, value] of Object.entries(themeStyles)) {
			if (value === undefined || value === null) {
				continue;
			}
			const property = key === "colorScheme" ? "color-scheme" : key;
			host.style.setProperty(property, String(value));
			keys.push(property);
		}
		return () => {
			for (const key of keys) {
				host.style.removeProperty(key);
			}
		};
	}, [themeStyles]);
	const availableEditorIds = useAvailableEditorIds(canUseNativeShell);
	const availableEditors = useMemo(
		() =>
			EDITOR_DEFS.filter(
				(def) => def.id !== "explorer" && availableEditorIds.has(def.id)
			),
		[availableEditorIds]
	);

	if (!canUseNativeShell) {
		return (
			<div className="flex h-full items-center justify-center text-muted-foreground text-xs">
				Project files require the local Desktop filesystem.
			</div>
		);
	}
	if (pluginFile && folder) {
		return (
			<PluginFilePanel
				handler={pluginFile.handler}
				onClose={() => setPluginFile(null)}
				path={pluginFile.path}
			/>
		);
	}
	if (!folder) {
		return (
			<div className="flex h-full items-center justify-center text-muted-foreground text-xs">
				No project folder open.
			</div>
		);
	}

	if (
		loading &&
		(resolvedListingScopeRef.current !== operationScope || paths.length === 0)
	) {
		return (
			<div className="flex h-full animate-skeleton items-center justify-center text-muted-foreground text-xs">
				Loading files…
			</div>
		);
	}

	if (listingError) {
		return (
			<div className="flex h-full flex-col items-center justify-center gap-3 p-4 text-center text-xs">
				<p className="text-muted-foreground" role="alert">
					{listingError}
				</p>
				<Button
					onClick={() => setListingAttempt((attempt) => attempt + 1)}
					size="sm"
					variant="outline"
				>
					Retry file listing
				</Button>
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

	// The viewer overlays the tree instead of replacing it so the tree's model
	// keeps its expansion and scroll position for "Back to files".
	const openViewerExternally = () => {
		if (!viewerPath) {
			return;
		}
		const editor =
			defaultFileOpener === "system"
				? null
				: (availableEditors.find((def) => def.id === defaultFileOpener)?.id ??
					null);
		invoke("open_workspace_item", {
			editor,
			path: viewerPath,
			root: folder,
		}).catch((error: unknown) =>
			toast.error("Couldn't open that workspace item", {
				description: error instanceof Error ? error.message : String(error),
			})
		);
	};

	return (
		<div className="relative flex h-full flex-col">
			{viewerPath ? (
				<div className="absolute inset-0 z-10 bg-background">
					<FileAnnotationViewer
						folder={folder}
						key={viewerPath}
						notes={notesByPath[viewerPath] ?? []}
						onClose={() => setViewerPath(null)}
						onNotesChange={(notes) =>
							setNotesByPath((current) => ({
								...current,
								[viewerPath]: notes,
							}))
						}
						onOpenExternally={openViewerExternally}
						path={viewerPath}
					/>
				</div>
			) : null}
			{/* Inline controls — the simple subset. Full option set lives in
			    Settings › Appearance › File tree. */}
			<div
				className="flex h-10 shrink-0 items-center gap-1 border-border border-b px-2"
				inert={viewerPath !== null}
			>
				<div className="flex shrink-0 items-center rounded-lg bg-muted p-0.5">
					{(
						[
							["compact", "Compact"],
							["default", "Default"],
							["relaxed", "Relaxed"],
						] as const
					).map(([value, label]) => (
						<button
							aria-pressed={prefs.density === value}
							className={cn(
								"h-6 rounded-lg px-2 text-xs transition-colors duration-150",
								prefs.density === value
									? "bg-background text-foreground"
									: "text-muted-foreground hover:text-foreground"
							)}
							key={value}
							onClick={() => setFileTreePrefs({ density: value })}
							type="button"
						>
							{label}
						</button>
					))}
				</div>
				<div className="flex-1" />
				<Tooltip>
					<TooltipTrigger
						render={
							<Button
								aria-label="Toggle file search"
								aria-pressed={prefs.showSearch}
								className="shrink-0 aria-pressed:text-foreground"
								onClick={() =>
									setFileTreePrefs({ showSearch: !prefs.showSearch })
								}
								size="icon-sm"
								variant="ghost-muted"
							>
								<HugeiconsIcon className="size-4" icon={Search01Icon} />
							</Button>
						}
					/>
					<TooltipContent>
						{prefs.showSearch ? "Hide search" : "Show search"}
					</TooltipContent>
				</Tooltip>
			</div>
			{/* @pierre/trees virtualizes at height:100% with a flex-1/min-h-0 inner
			    scroller, so every ancestor needs a definite height. Keyed on the
			    constructor-time OPTIONS (not the whole prefs blob) so display options
			    take effect — theme is applied as host CSS variables instead, and
			    keying on it would throw away expansion/scroll state on every switch. */}
			<div
				className="min-h-0 flex-1 overflow-hidden p-1"
				inert={viewerPath !== null}
				ref={treeThemeHost}
			>
				<FileTreeView
					availableEditors={availableEditors}
					canMoveItem={canMoveItem}
					folder={folder}
					key={JSON.stringify([folder, options])}
					onMoveItem={moveItem}
					onMoveItems={moveItems}
					onOpenPluginFile={(path, handler) => setPluginFile({ path, handler })}
					onViewFile={setViewerPath}
					options={options}
					paths={paths}
					searchRequest={searchRequest}
				/>
			</div>
		</div>
	);
}
