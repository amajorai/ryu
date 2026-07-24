"use client";

// apps/desktop/src/components/chat/NodeFolderBrowser.tsx
//
// Node-aware folder browser. Replaces the native OS folder picker (which only
// sees the desktop host) so a user can pick a project folder on the ACTIVE node
// even when that node is REMOTE. Renders the node's directory hierarchy as an
// expandable tree, lazily loading each folder's children from Core's
// `GET /api/workspace/list` (see lib/api/workspace.ts) the first time it is
// expanded, and confirms the selected folder via `onSelect(path)`. The parent
// owns opening/closing and what a selection does (typically `setFolder`).
//
// Windows nodes start at the drive list ("This PC", the `::this-pc` sentinel
// Core resolves into drives); other nodes start at the home directory. Both
// roots open expanded so the tree shows folders immediately.

import {
	ArrowRight01Icon,
	Folder03Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ryu/ui/components/dialog";
import { Input } from "@ryu/ui/components/input";
import { Spinner } from "@ryu/ui/components/spinner";
import { cn } from "@ryu/ui/lib/utils";
import { useCallback, useEffect, useRef, useState } from "react";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import { type DirectoryEntry, listDirectory } from "@/src/lib/api/workspace.ts";

interface NodeFolderBrowserProps {
	/** Called when the dialog requests to open/close. */
	onOpenChange: (open: boolean) => void;
	/** Called with the absolute path of the folder the user confirmed. */
	onSelect: (path: string) => void;
	/** Whether the dialog is open (controlled by the parent). */
	open: boolean;
}

// The Windows "This PC" sentinel Core resolves into a drive listing (git.rs).
const THIS_PC = "::this-pc";

/** One folder row plus (when expanded) its lazily-loaded sub-folders. Every node
 *  is a directory, so every row is expandable. */
function FolderRow({
	node,
	depth,
	expanded,
	childrenByPath,
	loadingPaths,
	selected,
	onToggle,
	onSelect,
}: {
	node: DirectoryEntry;
	depth: number;
	expanded: ReadonlySet<string>;
	childrenByPath: ReadonlyMap<string, DirectoryEntry[]>;
	loadingPaths: ReadonlySet<string>;
	selected: string | null;
	onToggle: (path: string) => void;
	onSelect: (path: string) => void;
}) {
	const isOpen = expanded.has(node.path);
	const isSelected = node.path === selected;
	const children = childrenByPath.get(node.path);
	const isLoading = loadingPaths.has(node.path);

	return (
		<div>
			<button
				className={cn(
					"flex w-full items-center gap-1.5 rounded-md py-1.5 pr-2 text-left text-sm transition-colors hover:bg-foreground/10",
					isSelected && "bg-foreground/10"
				)}
				onClick={() => {
					onSelect(node.path);
					onToggle(node.path);
				}}
				style={{ paddingLeft: `${depth * 16 + 8}px` }}
				type="button"
			>
				<HugeiconsIcon
					className={cn(
						"size-3.5 shrink-0 text-foreground/40 transition-transform",
						isOpen && "rotate-90"
					)}
					icon={ArrowRight01Icon}
				/>
				<HugeiconsIcon
					className="size-4 shrink-0 text-foreground/40"
					icon={Folder03Icon}
				/>
				<span className="min-w-0 flex-1 truncate text-foreground/80">
					{node.name}
				</span>
			</button>

			{isOpen && (
				<>
					{isLoading && (
						<p
							className="py-1 text-[11px] text-muted-foreground"
							style={{ paddingLeft: `${(depth + 1) * 16 + 24}px` }}
						>
							Loading…
						</p>
					)}
					{!isLoading && children?.length === 0 && (
						<p
							className="py-1 text-[11px] text-muted-foreground"
							style={{ paddingLeft: `${(depth + 1) * 16 + 24}px` }}
						>
							No sub-folders.
						</p>
					)}
					{children?.map((child) => (
						<FolderRow
							childrenByPath={childrenByPath}
							depth={depth + 1}
							expanded={expanded}
							key={child.path}
							loadingPaths={loadingPaths}
							node={child}
							onSelect={onSelect}
							onToggle={onToggle}
							selected={selected}
						/>
					))}
				</>
			)}
		</div>
	);
}

/**
 * A dialog that browses the active node's filesystem as a lazy, expandable tree
 * and confirms a folder. Errors from the node (404/403) surface inline.
 */
export function NodeFolderBrowser({
	open,
	onOpenChange,
	onSelect,
}: NodeFolderBrowserProps) {
	const activeNode = useActiveNode();
	const nodeUrl = activeNode.url;
	const nodeToken = activeNode.token ?? null;

	const [roots, setRoots] = useState<DirectoryEntry[]>([]);
	const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
	const [childrenByPath, setChildrenByPath] = useState<
		ReadonlyMap<string, DirectoryEntry[]>
	>(new Map());
	const [loadingPaths, setLoadingPaths] = useState<ReadonlySet<string>>(
		new Set()
	);
	const [selected, setSelected] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	// The text in the top path input, and whether it currently names no dir.
	const [pathInput, setPathInput] = useState("");
	const [pathInvalid, setPathInvalid] = useState(false);
	// Monotonic id so out-of-order list responses (debounced typing, node
	// switches) can't clobber a newer one. Any list bumps it and bails if stale.
	const listReqId = useRef(0);

	// Load a folder's children once, caching them so re-expanding is instant.
	const loadChildren = useCallback(
		async (path: string) => {
			setLoadingPaths((prev) => new Set(prev).add(path));
			try {
				const listing = await listDirectory(
					{ url: nodeUrl, token: nodeToken },
					path
				);
				setChildrenByPath((prev) => new Map(prev).set(path, listing.entries));
			} catch {
				// Unreadable folder: cache an empty listing so it shows "No sub-folders".
				setChildrenByPath((prev) => new Map(prev).set(path, []));
			} finally {
				setLoadingPaths((prev) => {
					const next = new Set(prev);
					next.delete(path);
					return next;
				});
			}
		},
		[nodeUrl, nodeToken]
	);

	const handleToggle = useCallback(
		(path: string) => {
			setExpanded((prev) => {
				const next = new Set(prev);
				if (next.has(path)) {
					next.delete(path);
				} else {
					next.add(path);
				}
				return next;
			});
			// Load children on first expand only (cached listings stay put).
			if (!(childrenByPath.has(path) || loadingPaths.has(path))) {
				loadChildren(path);
			}
		},
		[childrenByPath, loadingPaths, loadChildren]
	);

	// Build the default roots (Windows drives, else the home dir) and open them.
	// Used on open, on node change, and when the path input is cleared.
	const buildDefaultRoots = useCallback(async () => {
		const reqId = ++listReqId.current;
		const target: ApiTarget = { url: nodeUrl, token: nodeToken };
		setLoading(true);
		setError(null);
		setPathInvalid(false);
		setSelected(null);
		setExpanded(new Set());
		setChildrenByPath(new Map());
		setLoadingPaths(new Set());

		try {
			// Windows: roots are the drives (This PC). Other OSes: the home dir.
			let nextRoots: DirectoryEntry[];
			try {
				const pc = await listDirectory(target, THIS_PC);
				nextRoots = pc.entries;
			} catch {
				const home = await listDirectory(target);
				const name = home.path.split(/[\\/]/).filter(Boolean).at(-1);
				nextRoots = [{ name: name ?? home.path, path: home.path }];
			}

			// Eagerly load one level under each root so the tree opens populated.
			const childEntries = await Promise.all(
				nextRoots.map((r) =>
					listDirectory(target, r.path)
						.then((l) => [r.path, l.entries] as const)
						.catch(() => [r.path, [] as DirectoryEntry[]] as const)
				)
			);

			// A newer list request (typed path or node change) superseded this one.
			if (reqId !== listReqId.current) {
				return;
			}
			setRoots(nextRoots);
			setExpanded(new Set(nextRoots.map((r) => r.path)));
			setChildrenByPath(new Map(childEntries));
		} catch (e) {
			if (reqId === listReqId.current) {
				setError(e instanceof Error ? e.message : "Could not browse this node");
			}
		} finally {
			if (reqId === listReqId.current) {
				setLoading(false);
			}
		}
	}, [nodeUrl, nodeToken]);

	// Re-root the tree at a typed path so the tree reflects what the user typed.
	// Guarded by the same request id so out-of-order responses can't win, and
	// confirms on Core's canonical path — not the raw input string.
	const focusPath = useCallback(
		async (rawPath: string) => {
			const reqId = ++listReqId.current;
			const target: ApiTarget = { url: nodeUrl, token: nodeToken };
			try {
				const listing = await listDirectory(target, rawPath);
				if (reqId !== listReqId.current) {
					return;
				}
				const name =
					listing.path.split(/[\\/]/).filter(Boolean).at(-1) ?? listing.path;
				setRoots([{ name, path: listing.path }]);
				setExpanded(new Set([listing.path]));
				setChildrenByPath(new Map([[listing.path, listing.entries]]));
				setLoadingPaths(new Set());
				setSelected(listing.path);
				setPathInvalid(false);
				setError(null);
			} catch {
				// Invalid/unreadable mid-typing: keep the last good tree, flag quietly
				// (aria-invalid on the input) rather than blowing the tree away.
				if (reqId === listReqId.current) {
					setPathInvalid(true);
				}
			}
		},
		[nodeUrl, nodeToken]
	);

	// Debounce typed-path lists; an empty field returns to the default roots.
	const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const runPathList = useCallback(
		(value: string) => {
			const trimmed = value.trim();
			if (trimmed === "") {
				buildDefaultRoots();
			} else {
				focusPath(trimmed);
			}
		},
		[buildDefaultRoots, focusPath]
	);

	// onChange fires only on real typing/paste, so mirroring a tree click back
	// into the input (handleTreeSelect) never re-triggers a list.
	const handlePathInputChange = useCallback(
		(value: string) => {
			setPathInput(value);
			setPathInvalid(false);
			if (debounceRef.current) {
				clearTimeout(debounceRef.current);
			}
			debounceRef.current = setTimeout(() => runPathList(value), 300);
		},
		[runPathList]
	);

	// Mirror a tree click into the input for coherence. A programmatic setState
	// here does NOT fire the input's onChange, so the tree won't collapse.
	const handleTreeSelect = useCallback((path: string) => {
		setSelected(path);
		setPathInput(path);
		setPathInvalid(false);
	}, []);

	// (Re)build the tree whenever the dialog opens or the active node changes.
	useEffect(() => {
		if (!open) {
			return;
		}
		setPathInput("");
		buildDefaultRoots();
		return () => {
			if (debounceRef.current) {
				clearTimeout(debounceRef.current);
			}
		};
	}, [open, buildDefaultRoots]);

	const handleConfirm = useCallback(() => {
		if (selected) {
			onSelect(selected);
			onOpenChange(false);
		}
	}, [selected, onSelect, onOpenChange]);

	return (
		<Dialog onOpenChange={onOpenChange} open={open}>
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>Open a folder</DialogTitle>
					<DialogDescription>
						Browse folders on{" "}
						{activeNode.name === "local"
							? "this computer"
							: `the "${activeNode.name}" node`}
						.
					</DialogDescription>
				</DialogHeader>

				{/* Type a path to jump straight to it, or pick one in the tree below. */}
				<Input
					aria-invalid={pathInvalid || undefined}
					autoCapitalize="off"
					autoCorrect="off"
					className="font-mono text-[12px]"
					onChange={(e) => handlePathInputChange(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter") {
							e.preventDefault();
							if (debounceRef.current) {
								clearTimeout(debounceRef.current);
							}
							runPathList(pathInput);
						}
					}}
					placeholder="Type a folder path, or pick one below…"
					spellCheck={false}
					value={pathInput}
				/>

				{/* Expandable folder tree. */}
				<div className="h-72 overflow-y-auto rounded-lg border border-border p-1">
					{loading && (
						<div className="flex h-full items-center justify-center">
							<Spinner />
						</div>
					)}
					{!loading && error && (
						<p className="px-3 py-2 text-[12px] text-destructive">{error}</p>
					)}
					{!(loading || error) &&
						roots.map((root) => (
							<FolderRow
								childrenByPath={childrenByPath}
								depth={0}
								expanded={expanded}
								key={root.path}
								loadingPaths={loadingPaths}
								node={root}
								onSelect={handleTreeSelect}
								onToggle={handleToggle}
								selected={selected}
							/>
						))}
				</div>

				<DialogFooter>
					<DialogClose render={<Button variant="ghost" />}>Cancel</DialogClose>
					<Button disabled={!selected} onClick={handleConfirm} type="button">
						Select this folder
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
