import { Button } from "@ryu/blocks/companion/controls";
import { cn } from "@ryu/ui/lib/utils.ts";
import type { DragEvent as ReactDragEvent, RefObject } from "react";
import { VISUAL_BLOCKS } from "./blocks.ts";
import { type outline, ROOT_NODE_ID } from "./core.ts";
import styles from "./visual-editor.module.css";
import {
	BLOCK_MIME,
	NODE_MIME,
	type VisualLayoutStyle,
} from "./visual-editor-config.ts";

export function VisualEditorSidebar({
	disabled,
	insertBlock,
	layerDrag,
	layers,
	onLayerDrop,
	selectedId,
	setSelectedId,
	setTab,
	tab,
}: {
	disabled: boolean;
	insertBlock: (id: string) => void;
	layerDrag: RefObject<string | null>;
	layers: ReturnType<typeof outline>;
	onLayerDrop: (event: ReactDragEvent<HTMLElement>, overId: string) => void;
	selectedId: string | null;
	setSelectedId: (id: string | null) => void;
	setTab: (tab: "add" | "layers") => void;
	tab: "add" | "layers";
}) {
	return (
		<aside
			aria-label="Blocks and layers"
			className="flex max-h-80 flex-col gap-2 overflow-auto rounded-lg border p-2 lg:max-h-none lg:min-h-0"
		>
			<div className="flex gap-1">
				<Button
					aria-pressed={tab === "add"}
					onClick={() => setTab("add")}
					size="sm"
					variant={tab === "add" ? "secondary" : "ghost"}
				>
					Add
				</Button>
				<Button
					aria-pressed={tab === "layers"}
					onClick={() => setTab("layers")}
					size="sm"
					variant={tab === "layers" ? "secondary" : "ghost"}
				>
					Layers
				</Button>
			</div>
			{tab === "add" ? (
				<ul className="flex flex-col gap-1">
					{VISUAL_BLOCKS.map((block) => (
						<li key={block.id}>
							<button
								className="w-full cursor-grab rounded-md border px-2 py-1.5 text-start text-sm hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
								disabled={disabled}
								draggable={!disabled}
								onClick={() => insertBlock(block.id)}
								onDragStart={(event) => {
									event.dataTransfer.effectAllowed = "copy";
									event.dataTransfer.setData(BLOCK_MIME, block.id);
								}}
								title={block.description}
								type="button"
							>
								{block.label}
							</button>
						</li>
					))}
					<li className="px-1 pt-1 text-muted-foreground text-xs">
						Drag onto the page, or click to add after the selection.
					</li>
				</ul>
			) : (
				<ul
					aria-label="Layers"
					className="flex min-h-0 flex-col overflow-auto text-sm"
				>
					{layers.map((node) => (
						<li key={node.id}>
							<button
								aria-current={node.id === selectedId ? "true" : undefined}
								className={cn(
									"flex w-full items-baseline gap-1 truncate rounded px-1 py-0.5 text-start hover:bg-muted",
									styles.layer,
									node.id === selectedId && "bg-muted font-medium"
								)}
								draggable={node.id !== ROOT_NODE_ID && !disabled}
								onClick={() => setSelectedId(node.id)}
								onDragOver={(event) => event.preventDefault()}
								onDragStart={(event) => {
									layerDrag.current = node.id;
									event.dataTransfer.effectAllowed = "move";
									event.dataTransfer.setData(NODE_MIME, node.id);
								}}
								onDrop={(event) => onLayerDrop(event, node.id)}
								style={
									{
										"--visual-layer-indent": `${node.depth * 12 + 4}px`,
									} satisfies VisualLayoutStyle as VisualLayoutStyle
								}
								type="button"
							>
								<span className="font-mono text-muted-foreground text-xs">
									{node.id === ROOT_NODE_ID ? "page" : node.tag}
								</span>
								<span className="truncate" title={node.label}>
									{node.label}
								</span>
							</button>
						</li>
					))}
				</ul>
			)}
		</aside>
	);
}
