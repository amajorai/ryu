"use client";
import layout from "./chat-layout.module.css";

// One expandable folder row of NodeFolderBrowser (split out of
// NodeFolderBrowser.tsx).

import { ArrowRight01Icon, Folder03Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { CommandItem } from "@ryu/ui/components/command.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import type { CSSProperties } from "react";

interface FolderIndentStyle extends CSSProperties {
	"--folder-indent": string;
}

import type { DirectoryEntry } from "@/src/lib/api/workspace.ts";

/** One folder row plus (when expanded) its lazily-loaded sub-folders. Every node
 *  is a directory, so every row is expandable. */
export function FolderRow({
	node,
	depth,
	expanded,
	childrenByPath,
	loadingPaths,
	childErrors,
	onRetry,
	selected,
	onToggle,
	onSelect,
}: {
	node: DirectoryEntry;
	depth: number;
	expanded: ReadonlySet<string>;
	childrenByPath: ReadonlyMap<string, DirectoryEntry[]>;
	loadingPaths: ReadonlySet<string>;
	childErrors: ReadonlyMap<string, string>;
	onRetry: (path: string) => void;
	selected: string | null;
	onToggle: (path: string) => void;
	onSelect: (path: string) => void;
}) {
	const rowIndent: FolderIndentStyle = {
		"--folder-indent": `${depth * 16 + 8}px`,
	};
	const noteIndent: FolderIndentStyle = {
		"--folder-indent": `${(depth + 1) * 16 + 24}px`,
	};
	const isOpen = expanded.has(node.path);
	const isSelected = node.path === selected;
	const children = childrenByPath.get(node.path);
	const isLoading = loadingPaths.has(node.path);

	return (
		<>
			<CommandItem
				data-checked={isSelected}
				onSelect={() => {
					onSelect(node.path);
					onToggle(node.path);
				}}
				value={node.path}
			>
				<span className="w-(--folder-indent) shrink-0" style={rowIndent} />
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
				<span
					className="min-w-0 flex-1 truncate text-foreground/80"
					title={node.name}
				>
					{node.name}
				</span>
			</CommandItem>

			{isOpen && (
				<>
					{isLoading && (
						<p
							className={cn(
								layout.folderNote,
								"type-caption py-1 text-muted-foreground"
							)}
							style={noteIndent}
						>
							Loading…
						</p>
					)}
					{!isLoading && childErrors.has(node.path) && (
						<div
							className="px-3 py-1 text-status-destructive text-xs"
							role="alert"
						>
							{childErrors.get(node.path)}
							<Button
								onClick={() => onRetry(node.path)}
								size="sm"
								variant="ghost"
							>
								Retry folder
							</Button>
						</div>
					)}
					{!isLoading && children?.length === 0 && (
						<p
							className={cn(
								layout.folderNote,
								"type-caption py-1 text-muted-foreground"
							)}
							style={noteIndent}
						>
							No sub-folders.
						</p>
					)}
					{children?.map((child) => (
						<FolderRow
							childErrors={childErrors}
							childrenByPath={childrenByPath}
							depth={depth + 1}
							expanded={expanded}
							key={child.path}
							loadingPaths={loadingPaths}
							node={child}
							onRetry={onRetry}
							onSelect={onSelect}
							onToggle={onToggle}
							selected={selected}
						/>
					))}
				</>
			)}
		</>
	);
}
