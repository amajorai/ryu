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

import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Command,
	CommandDialog,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandList,
	CommandSeparator,
} from "@ryu/ui/components/command.tsx";
import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import { useCallback, useEffect, useRef, useState } from "react";

import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import { type DirectoryEntry, listDirectory } from "@/src/lib/api/workspace.ts";
import { FolderRow } from "./NodeFolderBrowser-folder-row.tsx";

interface NodeFolderBrowserProps {
	/** Called when the command dialog requests to open/close. */
	onOpenChange: (open: boolean) => void;
	/** Called with the absolute path of the folder the user confirmed. */
	onSelect: (path: string) => void;
	/** Whether the command dialog is open (controlled by the parent). */
	open: boolean;
}

// The Windows "This PC" sentinel Core resolves into a drive listing (git.rs).
const THIS_PC = "::this-pc";

/**
 * A command dialog that browses the active node's filesystem as a lazy,
 * expandable tree and confirms a folder. Errors from the node (404/403) surface
 * inline.
 */
export function NodeFolderBrowser({
	open,
	onOpenChange,
	onSelect,
}: NodeFolderBrowserProps) {
	const activeNode = useActiveNode();
	const tl = useLiteralMessages();
	const nodeUrl = activeNode.url;
	const nodeToken = activeNode.token ?? null;
	const nodeUserJwt = activeNode.userJwt ?? null;

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
	const browserSession = useRef(0);
	const [childErrors, setChildErrors] = useState<ReadonlyMap<string, string>>(
		new Map()
	);

	// Load a folder's children once, caching them so re-expanding is instant.
	const loadChildren = useCallback(
		async (path: string) => {
			const session = browserSession.current;
			setChildErrors((previous) => {
				const next = new Map(previous);
				next.delete(path);
				return next;
			});
			setLoadingPaths((prev) => new Set(prev).add(path));
			try {
				const listing = await listDirectory(
					{ url: nodeUrl, token: nodeToken, userJwt: nodeUserJwt },
					path
				);
				if (session === browserSession.current) {
					setChildrenByPath((prev) => new Map(prev).set(path, listing.entries));
				}
			} catch (cause) {
				if (session === browserSession.current) {
					setChildErrors((previous) =>
						new Map(previous).set(
							path,
							cause instanceof Error ? cause.message : "Could not read folder"
						)
					);
				}
			} finally {
				if (session === browserSession.current) {
					setLoadingPaths((prev) => {
						const next = new Set(prev);
						next.delete(path);
						return next;
					});
				}
			}
		},
		[nodeUrl, nodeToken, nodeUserJwt]
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
		browserSession.current += 1;
		setChildErrors(new Map());
		const target: ApiTarget = {
			url: nodeUrl,
			token: nodeToken,
			userJwt: nodeUserJwt,
		};
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
						.catch((): readonly [string, DirectoryEntry[]] => [r.path, []])
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
	}, [nodeUrl, nodeToken, nodeUserJwt]);

	// Re-root the tree at a typed path so the tree reflects what the user typed.
	// Guarded by the same request id so out-of-order responses can't win, and
	// confirms on Core's canonical path — not the raw input string.
	const focusPath = useCallback(
		async (rawPath: string) => {
			const reqId = ++listReqId.current;
			const target: ApiTarget = {
				url: nodeUrl,
				token: nodeToken,
				userJwt: nodeUserJwt,
			};
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
		[nodeUrl, nodeToken, nodeUserJwt]
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
			listReqId.current += 1;
			setPathInput(value);
			setSelected(null);
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
		if (debounceRef.current) {
			clearTimeout(debounceRef.current);
		}
		listReqId.current += 1;
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
			listReqId.current += 1;
			browserSession.current += 1;
			if (debounceRef.current) {
				clearTimeout(debounceRef.current);
			}
		};
	}, [open, buildDefaultRoots]);

	const handleConfirm = useCallback(() => {
		if (selected && !pathInvalid) {
			onSelect(selected);
			onOpenChange(false);
		}
	}, [selected, pathInvalid, onSelect, onOpenChange]);

	const isLocalNode = activeNode.name === "local";
	const nodeName = activeNode.name;
	const browseDescription = isLocalNode
		? tl("Browse folders on this device and add one as a Ryu project.")
		: tl('Browse folders on the "{name}" node and add one as a Ryu project.', {
				name: nodeName,
			});
	const foldersHeading = isLocalNode
		? tl("Folders on this device")
		: tl('Folders on the "{name}" node', { name: nodeName });

	return (
		<CommandDialog
			className="sm:max-w-lg"
			description={browseDescription}
			onOpenChange={onOpenChange}
			open={open}
			title="Add a project folder to Ryu"
		>
			<Command shouldFilter={false}>
				{/* Type a path to jump straight to it, or pick one in the tree below. */}
				<CommandInput
					aria-invalid={pathInvalid || undefined}
					autoCapitalize="off"
					autoCorrect="off"
					onKeyDown={(e) => {
						if (e.key === "Enter") {
							e.preventDefault();
							if (debounceRef.current) {
								clearTimeout(debounceRef.current);
							}
							runPathList(pathInput);
						}
					}}
					onValueChange={handlePathInputChange}
					placeholder="Type a folder path, or pick one below…"
					spellCheck={false}
					value={pathInput}
				/>

				<CommandList className="h-72 max-h-72">
					{loading && <SkeletonRows rows={6} spacing="library" />}
					{!loading && error && (
						<p className="px-3 py-2 text-status-destructive text-xs">{error}</p>
					)}
					{!(loading || error) && roots.length === 0 && (
						<CommandEmpty>No folders found.</CommandEmpty>
					)}
					{!(loading || error) && (
						<CommandGroup heading={foldersHeading}>
							{roots.map((root) => (
								<FolderRow
									childErrors={childErrors}
									childrenByPath={childrenByPath}
									depth={0}
									expanded={expanded}
									key={root.path}
									loadingPaths={loadingPaths}
									node={root}
									onRetry={loadChildren}
									onSelect={handleTreeSelect}
									onToggle={handleToggle}
									selected={selected}
								/>
							))}
						</CommandGroup>
					)}
				</CommandList>

				<CommandSeparator className="m-0" />
				<div className="flex justify-end gap-2 p-2">
					<Button onClick={() => onOpenChange(false)} variant="ghost">
						Cancel
					</Button>
					<Button
						disabled={!selected || pathInvalid}
						onClick={handleConfirm}
						type="button"
					>
						Add folder to Ryu
					</Button>
				</div>
			</Command>
		</CommandDialog>
	);
}
