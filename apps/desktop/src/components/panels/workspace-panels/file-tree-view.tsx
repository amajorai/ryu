import {
	File01Icon,
	FolderOpenIcon,
	Message01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type {
	ContextMenuItem as FileTreeContextMenuItem,
	ContextMenuOpenContext as FileTreeContextMenuOpenContext,
} from "@pierre/trees";
import { FileTree, useFileTree, useFileTreeSearch } from "@pierre/trees/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { invoke } from "@tauri-apps/api/core";
import { type CSSProperties, useEffect, useRef } from "react";
import { fileTreeRowPathFromEvent } from "@/src/components/panels/FileAnnotationViewer.tsx";
import { useAppSurface } from "@/src/contexts/app-surface-context.tsx";
import type { fileTreePrefsToOptions } from "@/src/hooks/useFileTreePrefs.ts";
import { usePluginContributions } from "@/src/hooks/usePluginContributions.ts";
import type { PluginFileHandler } from "@/src/lib/api/plugins.ts";
import { joinPath } from "@/src/lib/files.ts";
import { fileHandlersFor } from "@/src/lib/plugin-file-handlers.ts";
import type { FileTreeSearchRequest } from "@/src/store/useFileTreeSearchStore.ts";
import { useWorkspaceStore } from "@/src/store/useWorkspaceStore.ts";
import {
	type EditorDef,
	EditorIcon,
	fileManagerName,
	SHELL_EDITOR_IDS,
} from "./editor-buttons.tsx";

// Builds the `@pierre/trees` model ONCE (`useFileTree` captures its options at
// construction and ignores later changes) and pushes path updates through
// `resetPaths` — without this the tree stays empty, because `git ls-files`
// resolves after mount so the model is built with `[]`. The parent remounts this
// (via `key`) when display prefs change, since those are constructor-time.
export function FileTreeView({
	availableEditors,
	canMoveItem,
	onMoveItem,
	onMoveItems,
	onOpenPluginFile,
	onViewFile,
	folder,
	paths,
	options,
	searchRequest,
	style,
}: {
	availableEditors: readonly EditorDef[];
	canMoveItem(): boolean;
	onMoveItem(sourcePath: string, destinationPath: string): Promise<void>;
	onMoveItems(
		items: readonly { sourcePath: string; destinationPath: string }[]
	): Promise<void>;
	onOpenPluginFile(path: string, handler: PluginFileHandler): void;
	/** Opens a workspace-relative file in the dock's annotation viewer. */
	onViewFile(path: string): void;
	folder: string;
	options: ReturnType<typeof fileTreePrefsToOptions>;
	paths: readonly string[];
	searchRequest: FileTreeSearchRequest | null;
	style?: CSSProperties;
}) {
	const { model } = useFileTree({
		...options,
		paths,
		renaming: options.renaming
			? {
					canRename: () => canMoveItem(),
					onRename: ({ sourcePath, destinationPath }) => {
						void onMoveItem(sourcePath, destinationPath);
					},
					onError: (message) =>
						toast.error("Couldn't rename that workspace item", {
							description: message,
						}),
				}
			: false,
		dragAndDrop: options.dragAndDrop
			? {
					canDrag: (draggedPaths) => draggedPaths.length > 0 && canMoveItem(),
					canDrop: ({ draggedPaths }) =>
						draggedPaths.length > 0 && canMoveItem(),
					onDropComplete: ({ draggedPaths, target }) => {
						const directory = target.directoryPath?.replace(/\/+$/, "") ?? "";
						void onMoveItems(
							draggedPaths.map((sourcePath) => {
								const normalizedSource = sourcePath.replace(/\/+$/, "");
								const leaf = normalizedSource.slice(
									normalizedSource.lastIndexOf("/") + 1
								);
								return {
									sourcePath,
									destinationPath: directory ? `${directory}/${leaf}` : leaf,
								};
							})
						);
					},
					onDropError: (message) =>
						toast.error("Couldn't move that workspace item", {
							description: message,
						}),
				}
			: false,
	});
	const fileTreeSearch = useFileTreeSearch(model);
	const requestWasActiveRef = useRef(false);
	const lastRequestNonceRef = useRef<number | null>(null);
	useEffect(() => {
		const directories = new Set<string>();
		for (const path of paths) {
			for (
				let slash = path.indexOf("/");
				slash >= 0;
				slash = path.indexOf("/", slash + 1)
			) {
				directories.add(path.slice(0, slash + 1));
			}
		}
		const initialExpandedPaths = [...directories].filter((directory) => {
			const item = model.getItem(directory);
			return item && "isExpanded" in item && item.isExpanded();
		});
		model.resetPaths(paths, { initialExpandedPaths });
	}, [paths, model]);
	useEffect(() => {
		if (!searchRequest) {
			if (requestWasActiveRef.current) {
				requestWasActiveRef.current = false;
				lastRequestNonceRef.current = null;
				fileTreeSearch.close();
			}
			return;
		}

		requestWasActiveRef.current = true;
		if (lastRequestNonceRef.current !== searchRequest.nonce) {
			lastRequestNonceRef.current = searchRequest.nonce;
			fileTreeSearch.open(searchRequest.query);
			return;
		}
		if (fileTreeSearch.value !== searchRequest.query) {
			fileTreeSearch.setValue(searchRequest.query);
		}
	}, [fileTreeSearch, searchRequest]);
	// Rows are buttons rendered by @pierre/trees, so one delegated listener
	// covers pointer clicks and keyboard activation without wrapping the tree in
	// an interactive element of our own.
	const hostRef = useRef<HTMLDivElement>(null);
	const onViewFileRef = useRef(onViewFile);
	onViewFileRef.current = onViewFile;
	useEffect(() => {
		const host = hostRef.current;
		if (!host) {
			return;
		}
		const handleClick = (event: MouseEvent) => {
			if (event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) {
				return;
			}
			const path = fileTreeRowPathFromEvent(event.composedPath());
			if (path) {
				onViewFileRef.current(path);
			}
		};
		host.addEventListener("click", handleClick);
		return () => host.removeEventListener("click", handleClick);
	}, []);
	return (
		<div className="h-full w-full" ref={hostRef}>
			<FileTree
				className="h-full w-full"
				model={model}
				renderContextMenu={(item, context) => (
					<FileTreeContextActions
						availableEditors={availableEditors}
						context={context}
						folder={folder}
						item={item}
						onOpenPluginFile={onOpenPluginFile}
						onViewFile={onViewFile}
					/>
				)}
				style={style}
			/>
		</div>
	);
}

// The tree library positions and opens this menu itself (`renderContextMenu`),
// so it cannot mount the ContextMenu primitive's root. It borrows the menu
// geometry instead: a solid `rounded-xl p-1.5` popover with the primitive's
// shadow, and `h-8 px-2 rounded-lg` items that highlight with `bg-accent`.
const MENU_ITEM =
	"flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-sm outline-none transition-colors duration-150 hover:bg-accent hover:duration-0 focus-visible:bg-accent";

function FileTreeContextActions({
	availableEditors,
	onOpenPluginFile,
	onViewFile,
	context,
	folder,
	item,
}: {
	availableEditors: readonly EditorDef[];
	onOpenPluginFile(path: string, handler: PluginFileHandler): void;
	onViewFile(path: string): void;
	context: FileTreeContextMenuOpenContext;
	folder: string;
	item: FileTreeContextMenuItem;
}) {
	const tl = useLiteralMessages();
	const { canUseNativeShell } = useAppSurface();
	const { file_handlers: handlers = [], companions } = usePluginContributions();
	const fileHandlers =
		item.kind === "file"
			? fileHandlersFor(item.path, handlers, companions)
			: [];
	const defaultFileOpener = useWorkspaceStore((s) => s.defaultFileOpener);
	const configuredEditor =
		defaultFileOpener === "system" ? null : defaultFileOpener;
	const defaultEditor = configuredEditor
		? (availableEditors.find((editor) => editor.id === configuredEditor) ??
			null)
		: null;

	if (!canUseNativeShell) {
		return null;
	}

	const run = async (command: string, editor?: string) => {
		context.close({ restoreFocus: false });
		try {
			await invoke(command, {
				editor: editor ?? null,
				path: item.path,
				root: folder,
			});
		} catch (error) {
			toast.error("Couldn't open that workspace item", {
				description: error instanceof Error ? error.message : String(error),
			});
		}
	};

	return (
		<div
			aria-label={tl("Actions for {name}", { name: item.name })}
			className="min-w-52 rounded-xl border border-border bg-popover p-1.5 text-popover-foreground shadow-lg"
			data-file-tree-context-menu-root="true"
			role="menu"
		>
			{item.kind === "file" ? (
				<button
					className={MENU_ITEM}
					onClick={() => {
						context.close({ restoreFocus: false });
						onViewFile(item.path);
					}}
					role="menuitem"
					type="button"
				>
					<HugeiconsIcon className="size-4" icon={Message01Icon} />
					View and annotate
				</button>
			) : null}
			{fileHandlers.map((handler) => (
				<button
					className={MENU_ITEM}
					key={`${handler.plugin}:${handler.id}`}
					onClick={() => {
						context.close({ restoreFocus: false });
						onOpenPluginFile(joinPath(folder, item.path), handler);
					}}
					role="menuitem"
					type="button"
				>
					{tl("Open in {title}", { title: handler.title })}
				</button>
			))}
			<button
				className={MENU_ITEM}
				onClick={() => run("open_workspace_item", defaultEditor?.id)}
				role="menuitem"
				type="button"
			>
				<HugeiconsIcon className="size-4" icon={File01Icon} />
				{defaultEditor
					? tl("Open in {shortLabel}", { shortLabel: defaultEditor.shortLabel })
					: "Open"}
			</button>
			<button
				className={MENU_ITEM}
				onClick={() => run("reveal_workspace_item")}
				role="menuitem"
				type="button"
			>
				<HugeiconsIcon className="size-4" icon={FolderOpenIcon} />
				{tl("Reveal in {fileManagerName}", { fileManagerName })}
			</button>
			{availableEditors.length > 0 ? (
				<div className="-mx-1.5 my-1 h-px bg-border" role="separator" />
			) : null}
			{availableEditors.map((editor) => {
				const opensContainingFolder =
					item.kind === "file" && SHELL_EDITOR_IDS.has(editor.id);
				return (
					<button
						className={MENU_ITEM}
						key={editor.id}
						onClick={() => run("open_workspace_item", editor.id)}
						role="menuitem"
						type="button"
					>
						<EditorIcon def={editor} />
						{opensContainingFolder
							? tl("Open containing folder in {shortLabel}", {
									shortLabel: editor.shortLabel,
								})
							: editor.label}
					</button>
				);
			})}
		</div>
	);
}
