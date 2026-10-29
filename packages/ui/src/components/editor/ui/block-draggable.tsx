"use client";

import {
	DndPlugin,
	type ElementDragItemNode,
	useDraggable,
	useDropLine,
} from "@platejs/dnd";
import { expandListItemsWithChildren } from "@platejs/list";
import { BlockSelectionPlugin } from "@platejs/selection/react";
import { Button } from "@ryu/ui/components/editor/ui/button.tsx";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/editor/ui/tooltip.tsx";
import { useDropNudge } from "@ryu/ui/hooks/use-drop-nudge.ts";
import { isNativeNumber } from "@ryu/ui/lib/native-primitive-observation.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import { GripVertical } from "lucide-react";
import { getPluginByType, isType, KEYS, type TElement } from "platejs";
import {
	MemoizedChildren,
	type PlateEditor,
	type PlateElementProps,
	type RenderNodeWrapper,
	useEditorRef,
	useElement,
	usePluginOption,
	useSelected,
} from "platejs/react";
import type { CSSProperties as ReactCSSProperties } from "react";
import {
	type ComponentProps,
	memo,
	type RefObject,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import editorStyles from "../editor-lint.module.css";

interface EditorVariableStyle extends ReactCSSProperties {
	"--editorblockDraggable1-top"?: string | number;
	"--editorblockDraggable2-top"?: string | number;
}

const UNDRAGGABLE_KEYS = [KEYS.column, KEYS.tr, KEYS.td];

export const BlockDraggable: RenderNodeWrapper = (props) => {
	const { editor, element, path } = props;

	const enabled = useMemo(() => {
		if (editor.dom.readOnly) {
			return false;
		}

		if (path.length === 1 && !isType(editor, element, UNDRAGGABLE_KEYS)) {
			return true;
		}
		if (path.length === 3 && !isType(editor, element, UNDRAGGABLE_KEYS)) {
			const block = editor.api.some({
				at: path,
				match: {
					type: editor.getType(KEYS.column),
				},
			});

			if (block) {
				return true;
			}
		}
		if (path.length === 4 && !isType(editor, element, UNDRAGGABLE_KEYS)) {
			const block = editor.api.some({
				at: path,
				match: {
					type: editor.getType(KEYS.table),
				},
			});

			if (block) {
				return true;
			}
		}

		return false;
	}, [editor, element, path]);

	if (!enabled) {
		return;
	}

	return (props) => <Draggable {...props} />;
};

function Draggable(props: PlateElementProps) {
	const { children, editor, element, path } = props;
	const blockSelectionApi = editor.getApi(BlockSelectionPlugin).blockSelection;

	const { isAboutToDrag, isDragging, nodeRef, previewRef, handleRef } =
		useDraggable({
			element,
			onDropHandler: (_, { dragItem }) => {
				// SAFETY: The installed Dnd useDropNode routes packets without id to onDropFiles
				// before calling onDropHandler. This hook uses that native dispatcher and its
				// complete ElementDragItemNode packet, retaining every native field and id read.
				const id = (dragItem as ElementDragItemNode).id;

				if (blockSelectionApi) {
					blockSelectionApi.add(id);
				}
				resetPreview();
			},
		});

	const isInColumn = path.length === 3;
	const isInTable = path.length === 4;
	const wrapperRef = useRef<HTMLDivElement>(null);

	const [previewTop, setPreviewTop] = useState(0);

	const resetPreview = () => {
		if (previewRef.current) {
			previewRef.current.replaceChildren();
			previewRef.current?.classList.add("hidden");
		}
	};

	// clear up virtual multiple preview when drag end
	useEffect(() => {
		if (!isDragging) {
			resetPreview();
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [isDragging, resetPreview]);

	useEffect(() => {
		if (isAboutToDrag) {
			previewRef.current?.classList.remove("opacity-0");
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [isAboutToDrag, previewRef.current?.classList.remove]);

	const [dragButtonTop, setDragButtonTop] = useState(0);

	const editorblockDraggable1Style: EditorVariableStyle = {
		"--editorblockDraggable1-top": isNativeNumber(`${dragButtonTop + 3}px`)
			? `${`${dragButtonTop + 3}px`}px`
			: `${dragButtonTop + 3}px`,
	};
	const editorblockDraggable2Style: EditorVariableStyle = {
		"--editorblockDraggable2-top": isNativeNumber(`${-previewTop}px`)
			? `${`${-previewTop}px`}px`
			: `${-previewTop}px`,
	};
	return (
		<div
			className={cn(
				"relative",
				isDragging && "opacity-50",
				getPluginByType(editor, element.type)?.node.isContainer
					? "group/container"
					: "group"
			)}
			onMouseEnter={() => {
				if (isDragging) {
					return;
				}
				setDragButtonTop(calcDragButtonTop(editor, element));
			}}
			ref={wrapperRef}
		>
			{!isInTable && (
				<Gutter>
					<div className={cn("flex h-[1.5em]", isInColumn && "h-4")}>
						<div
							className={cn(
								"relative w-4.5",
								"pointer-events-auto me-1 flex items-center",
								isInColumn && "me-1.5"
							)}
						>
							<Button
								className={cn(
									"absolute -start-0 h-6 w-full p-0",
									editorStyles.editorblockDraggable1
								)}
								data-plate-prevent-deselect
								ref={handleRef}
								style={editorblockDraggable1Style}
								variant="ghost"
							>
								<DragHandle
									isDragging={isDragging}
									previewRef={previewRef}
									resetPreview={resetPreview}
									setPreviewTop={setPreviewTop}
								/>
							</Button>
						</div>
					</div>
				</Gutter>
			)}

			<div
				className={cn(
					"absolute -start-0 hidden w-full",
					editorStyles.editorblockDraggable2
				)}
				contentEditable={false}
				ref={previewRef}
				style={editorblockDraggable2Style}
			/>

			<div
				className="flow-root"
				onContextMenu={(event) =>
					editor
						.getApi(BlockSelectionPlugin)
						.blockSelection.addOnContextMenu({ element, event })
				}
				ref={nodeRef}
			>
				<MemoizedChildren>{children}</MemoizedChildren>
				<DropGap targetRef={wrapperRef} />
			</div>
		</div>
	);
}

function Gutter({ children, className, ...props }: ComponentProps<"div">) {
	const editor = useEditorRef();
	const element = useElement();
	const isSelectionAreaVisible = usePluginOption(
		BlockSelectionPlugin,
		"isSelectionAreaVisible"
	);
	const selected = useSelected();

	return (
		<div
			{...props}
			className={cn(
				"absolute top-0 z-50 flex h-full -translate-x-full cursor-text hover:opacity-100 sm:opacity-0 rtl:translate-x-full",
				getPluginByType(editor, element.type)?.node.isContainer
					? "group-hover/container:opacity-100"
					: "group-hover:opacity-100",
				isSelectionAreaVisible && "hidden",
				!selected && "opacity-0",
				className
			)}
			contentEditable={false}
		>
			{children}
		</div>
	);
}

const DragHandle = memo(function DragHandle({
	isDragging,
	previewRef,
	resetPreview,
	setPreviewTop,
}: {
	isDragging: boolean;
	previewRef: RefObject<HTMLDivElement | null>;
	resetPreview: () => void;
	setPreviewTop: (top: number) => void;
}) {
	const editor = useEditorRef();
	const element = useElement();

	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<div
						className="flex size-full items-center justify-center"
						data-plate-prevent-deselect
						onClick={(e) => {
							e.preventDefault();
							editor.getApi(BlockSelectionPlugin).blockSelection.focus();
						}}
						onMouseDown={(e) => {
							resetPreview();

							if ((e.button !== 0 && e.button !== 2) || e.shiftKey) {
								return;
							}

							const blockSelection = editor
								.getApi(BlockSelectionPlugin)
								.blockSelection.getNodes({ sort: true });

							let selectionNodes =
								blockSelection.length > 0
									? blockSelection
									: editor.api.blocks({ mode: "highest" });

							// If current block is not in selection, use it as the starting point
							if (!selectionNodes.some(([node]) => node.id === element.id)) {
								selectionNodes = [[element, editor.api.findPath(element)!]];
							}

							// Process selection nodes to include list children
							const blocks = expandListItemsWithChildren(
								editor,
								selectionNodes
							).map(([node]) => node);

							if (blockSelection.length === 0) {
								editor.tf.blur();
								editor.tf.collapse();
							}

							const elements = createDragPreviewElements(editor, blocks);
							previewRef.current?.append(...elements);
							previewRef.current?.classList.remove("hidden");
							previewRef.current?.classList.add("opacity-0");
							editor.setOption(DndPlugin, "multiplePreviewRef", previewRef);

							// SAFETY: The native selection API stores entries of this authored
							// outer array in its Set unchanged; do not claim each raw id is a string.
							editor
								.getApi(BlockSelectionPlugin)
								.blockSelection.set(blocks.map((block) => block.id as string));
						}}
						onMouseEnter={() => {
							if (isDragging) {
								return;
							}

							const blockSelection = editor
								.getApi(BlockSelectionPlugin)
								.blockSelection.getNodes({ sort: true });

							let selectedBlocks =
								blockSelection.length > 0
									? blockSelection
									: editor.api.blocks({ mode: "highest" });

							// If current block is not in selection, use it as the starting point
							if (!selectedBlocks.some(([node]) => node.id === element.id)) {
								selectedBlocks = [[element, editor.api.findPath(element)!]];
							}

							// Process selection to include list children
							const processedBlocks = expandListItemsWithChildren(
								editor,
								selectedBlocks
							);

							// SAFETY: This local array is consumed only by native Array.includes
							// identity checks below; retain the raw ids, without string validation.
							const ids = processedBlocks.map((block) => block[0].id as string);

							// SAFETY: Array.includes compares this unchanged node identity with
							// the raw ids just captured; the annotation supplies no string proof.
							if (ids.length > 1 && ids.includes(element.id as string)) {
								const previewTop = calculatePreviewTop(editor, {
									blocks: processedBlocks.map((block) => block[0]),
									element,
								});
								setPreviewTop(previewTop);
							} else {
								setPreviewTop(0);
							}
						}}
						onMouseUp={() => {
							resetPreview();
						}}
						role="button"
					/>
				}
			>
				<GripVertical className="text-muted-foreground" />
			</TooltipTrigger>
			<TooltipContent>Drag to move</TooltipContent>
		</Tooltip>
	);
});

/** Eases this block and its neighbour apart where a dragged block would drop,
 *  in place of a drawn drop line. */
const DropGap = memo(function DropGap({
	targetRef,
}: {
	targetRef: RefObject<HTMLDivElement | null>;
}) {
	const { dropLine } = useDropLine();
	useDropNudge(targetRef, dropLine);
	return null;
});

const createDragPreviewElements = (
	editor: PlateEditor,
	blocks: TElement[]
): HTMLElement[] => {
	const elements: HTMLElement[] = [];
	const ids: string[] = [];

	/**
	 * Remove data attributes from the element to avoid recognized as slate
	 * elements incorrectly.
	 */
	const removeDataAttributes = (element: Element) => {
		Array.from(element.attributes).forEach((attr) => {
			if (
				attr.name.startsWith("data-slate") ||
				attr.name.startsWith("data-block-id")
			) {
				element.removeAttribute(attr.name);
			}
		});

		Array.from(element.children).forEach((child) => {
			removeDataAttributes(child);
		});
	};

	const resolveElement = (node: TElement, index: number) => {
		const domNode = editor.api.toDOMNode(node)!;
		// SAFETY: Slate toDOMNode supplies this full HTMLElement. Native DOM cloneNode
		// preserves the concrete element interface; its inherited Node declaration
		// returns the broader base type. The complete clone is forwarded unchanged.
		const newDomNode = domNode.cloneNode(true) as HTMLElement;

		// Apply visual compensation for horizontal scroll
		const applyScrollCompensation = (
			original: Element,
			cloned: HTMLElement
		) => {
			const scrollLeft = original.scrollLeft;

			if (scrollLeft > 0) {
				// Create a wrapper to handle the scroll offset
				const scrollWrapper = document.createElement("div");
				scrollWrapper.style.overflow = "hidden";
				scrollWrapper.style.width = `${original.clientWidth}px`;

				// Create inner container with the full content
				const innerContainer = document.createElement("div");
				innerContainer.style.transform = `translateX(-${scrollLeft}px)`;
				innerContainer.style.width = `${original.scrollWidth}px`;

				// Move all children to the inner container
				while (cloned.firstChild) {
					innerContainer.append(cloned.firstChild);
				}

				// Apply the original element's styles to maintain appearance
				const originalStyles = window.getComputedStyle(original);
				cloned.style.padding = "0";
				innerContainer.style.padding = originalStyles.padding;

				scrollWrapper.append(innerContainer);
				cloned.append(scrollWrapper);
			}
		};

		applyScrollCompensation(domNode, newDomNode);

		// SAFETY: The complete native Dnd path keeps this original id in its
		// draggingId array, compares entries with Array.includes and forwards
		// them to native node lookup. It does not validate a string brand here.
		ids.push(node.id as string);
		const wrapper = document.createElement("div");
		wrapper.append(newDomNode);
		wrapper.style.display = "flow-root";

		const lastDomNode = blocks[index - 1];

		if (lastDomNode) {
			const lastDomNodeRect = editor.api
				.toDOMNode(lastDomNode)
				?.parentElement?.getBoundingClientRect();

			const domNodeRect = domNode.parentElement?.getBoundingClientRect();

			if (domNodeRect && lastDomNodeRect) {
				const distance = domNodeRect.top - lastDomNodeRect.bottom;

				// Check if the two elements are adjacent (touching each other)
				if (distance > 15) {
					wrapper.style.marginTop = `${distance}px`;
				}
			}
		}

		removeDataAttributes(newDomNode);
		elements.push(wrapper);
	};

	blocks.forEach((node, index) => {
		resolveElement(node, index);
	});

	editor.setOption(DndPlugin, "draggingId", ids);

	return elements;
};

const calculatePreviewTop = (
	editor: PlateEditor,
	{
		blocks,
		element,
	}: {
		blocks: TElement[];
		element: TElement;
	}
): number => {
	const child = editor.api.toDOMNode(element)!;
	const editable = editor.api.toDOMNode(editor)!;
	const firstSelectedChild = blocks[0];
	if (!firstSelectedChild) {
		return 0;
	}

	const firstDomNode = editor.api.toDOMNode(firstSelectedChild)!;
	// Get editor's top padding
	const editorPaddingTop = Number(
		window.getComputedStyle(editable).paddingTop.replace("px", "")
	);

	// Calculate distance from first selected node to editor top
	const firstNodeToEditorDistance =
		firstDomNode.getBoundingClientRect().top -
		editable.getBoundingClientRect().top -
		editorPaddingTop;

	// Get margin top of first selected node
	const firstMarginTopString = window.getComputedStyle(firstDomNode).marginTop;
	const marginTop = Number(firstMarginTopString.replace("px", ""));

	// Calculate distance from current node to editor top
	const currentToEditorDistance =
		child.getBoundingClientRect().top -
		editable.getBoundingClientRect().top -
		editorPaddingTop;

	const currentMarginTopString = window.getComputedStyle(child).marginTop;
	const currentMarginTop = Number(currentMarginTopString.replace("px", ""));

	const previewElementsTopDistance =
		currentToEditorDistance -
		firstNodeToEditorDistance +
		marginTop -
		currentMarginTop;

	return previewElementsTopDistance;
};

const calcDragButtonTop = (editor: PlateEditor, element: TElement): number => {
	const child = editor.api.toDOMNode(element)!;

	const currentMarginTopString = window.getComputedStyle(child).marginTop;
	const currentMarginTop = Number(currentMarginTopString.replace("px", ""));

	return currentMarginTop;
};
