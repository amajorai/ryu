import { Button, Label, Textarea } from "@ryu/blocks/companion/controls";
import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils.ts";
import {
	type DragEvent as ReactDragEvent,
	type KeyboardEvent as ReactKeyboardEvent,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { visualBlock } from "./blocks.ts";
import {
	CANVAS_SANDBOX,
	canvasDocument,
	SELECTED_ATTRIBUTE,
} from "./canvas.ts";
import {
	buildVisualEditPrompt,
	parseVisualEditResponse,
	VISUAL_EDIT_SYSTEM_PROMPT,
} from "./chat.ts";
import {
	canContainChildren,
	cleanHtml,
	type DropPosition,
	dropPositionFor,
	editHtml,
	findNode,
	outline,
	prepareHtml,
	ROOT_NODE_ID,
	resolveDrop,
	siblingPosition,
	type VisualOperation,
} from "./core.ts";
import styles from "./visual-editor.module.css";
import { attachCanvasListeners } from "./visual-editor-canvas-listeners.ts";
import {
	BLOCK_MIME,
	MAX_HISTORY,
	NODE_MIME,
	parser,
	VIEWPORT_WIDTH,
	type Viewport,
	type VisualEditorProps,
	type VisualLayoutStyle,
} from "./visual-editor-config.ts";
import { VisualEditorInspector } from "./visual-editor-inspector.tsx";
import { VisualEditorSidebar } from "./visual-editor-sidebar.tsx";

export type {
	VisualEditorComplete,
	VisualEditorProps,
} from "./visual-editor-config.ts";

/**
 * The shared visual + chat editor. Canvas drag and drop, the layers panel,
 * the inspector, and chat all edit through the same typed operations.
 */
export function VisualEditor({
	complete,
	disabled = false,
	html,
	onChange,
}: VisualEditorProps) {
	const tl = useLiteralMessages();
	const [working, setWorking] = useState(() => prepareHtml(html, parser()));
	const [past, setPast] = useState<string[]>([]);
	const [future, setFuture] = useState<string[]>([]);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [viewport, setViewport] = useState<Viewport>("desktop");
	const [tab, setTab] = useState<"add" | "layers">("add");
	const [request, setRequest] = useState("");
	const [chatBusy, setChatBusy] = useState(false);
	const [message, setMessage] = useState<{
		text: string;
		tone: "error" | "status";
	} | null>(null);
	const [loads, setLoads] = useState(0);
	const frameRef = useRef<HTMLIFrameElement>(null);
	const emitted = useRef(html);
	const layerDrag = useRef<string | null>(null);

	useEffect(() => {
		if (html !== emitted.current) {
			emitted.current = html;
			setWorking(prepareHtml(html, parser()));
			setPast([]);
			setFuture([]);
			setSelectedId(null);
		}
	}, [html]);

	const documentModel = useMemo(
		() => parser().parseFromString(working, "text/html"),
		[working]
	);
	const layers = useMemo(() => outline(documentModel), [documentModel]);
	const canvas = useMemo(() => canvasDocument(working, parser()), [working]);
	const selected = selectedId ? findNode(documentModel, selectedId) : null;

	const commitHtml = useCallback(
		(next: string) => {
			setPast((items) => [...items.slice(-(MAX_HISTORY - 1)), working]);
			setFuture([]);
			setWorking(next);
			const clean = cleanHtml(next, parser());
			emitted.current = clean;
			onChange(clean);
		},
		[onChange, working]
	);

	const apply = useCallback(
		(operations: VisualOperation[], select?: string | null): boolean => {
			const result = editHtml(working, operations, parser());
			if (!result.ok) {
				setMessage({ text: result.error, tone: "error" });
				return false;
			}
			setMessage(null);
			commitHtml(result.html);
			if (select !== undefined) {
				setSelectedId(select);
			}
			return true;
		},
		[commitHtml, working]
	);

	const travel = useCallback(
		(direction: "undo" | "redo") => {
			const source = direction === "undo" ? past : future;
			const target = source.at(-1);
			if (target === undefined) {
				return;
			}
			if (direction === "undo") {
				setPast(source.slice(0, -1));
				setFuture((items) => [...items, working]);
			} else {
				setFuture(source.slice(0, -1));
				setPast((items) => [...items, working]);
			}
			setWorking(target);
			const clean = cleanHtml(target, parser());
			emitted.current = clean;
			onChange(clean);
		},
		[future, onChange, past, working]
	);

	const dropOperations = useCallback(
		(
			dragged: { block?: string; node?: string },
			overId: string,
			position: DropPosition
		): VisualOperation[] | null => {
			const target = resolveDrop(
				documentModel,
				dragged.node ?? null,
				overId,
				position
			);
			if (!target) {
				return null;
			}
			if (dragged.node) {
				return [{ kind: "move", nodeId: dragged.node, ...target }];
			}
			const block = dragged.block ? visualBlock(dragged.block) : undefined;
			return block
				? [{ kind: "insertHtml", ...target, html: block.html }]
				: null;
		},
		[documentModel]
	);

	// The canvas listeners live in this realm; keep them pointed at fresh state.
	// `working` lets an in-flight chat edit see whether the page moved under it.
	const handlers = useRef({ apply, dropOperations, setSelectedId, working });
	handlers.current = { apply, dropOperations, setSelectedId, working };

	const bindCanvas = useCallback(() => {
		const frameDocument = frameRef.current?.contentDocument;
		if (!frameDocument) {
			return;
		}
		setLoads((count) => count + 1);
		attachCanvasListeners(frameDocument, handlers);
	}, []);

	useEffect(() => {
		const frameDocument = frameRef.current?.contentDocument;
		if (!frameDocument || loads === 0) {
			return;
		}
		for (const element of frameDocument.querySelectorAll(
			`[${SELECTED_ATTRIBUTE}]`
		)) {
			element.removeAttribute(SELECTED_ATTRIBUTE);
		}
		const node = selectedId ? findNode(frameDocument, selectedId) : null;
		node?.setAttribute(SELECTED_ATTRIBUTE, "");
		node?.scrollIntoView({ block: "nearest" });
	}, [loads, selectedId]);

	const runChat = async () => {
		if (!(complete && request.trim())) {
			return;
		}
		setChatBusy(true);
		setMessage(null);
		// The canvas, layers, inspector, and undo stay live while the model runs.
		// The reply's operations target this snapshot's node ids, so applying them
		// to a page the user has since edited would discard those edits.
		const snapshot = working;
		try {
			const selectedHtml = selected
				? cleanHtml(`<body>${selected.outerHTML}</body>`, parser())
				: null;
			const reply = await complete({
				system: VISUAL_EDIT_SYSTEM_PROMPT,
				prompt: buildVisualEditPrompt({
					outline: layers,
					request,
					selectedId,
					selectedHtml,
				}),
			});
			const parsed = parseVisualEditResponse(reply);
			if (!parsed.ok) {
				setMessage({ text: parsed.error, tone: "error" });
				return;
			}
			if (handlers.current.working !== snapshot) {
				setMessage({
					text: "The page changed while the edit was running. Send the request again to apply it to the current page.",
					tone: "error",
				});
				return;
			}
			if (handlers.current.apply(parsed.operations)) {
				setMessage({
					text: tl("{summary} Undo is available.", {
						summary: parsed.summary,
					}),
					tone: "status",
				});
				setRequest("");
			}
		} catch (cause) {
			setMessage({
				text:
					cause instanceof Error ? cause.message : "The model request failed",
				tone: "error",
			});
		} finally {
			setChatBusy(false);
		}
	};

	const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
		// SAFETY: this rendered control receives native element key targets; only
		// Element.tagName is read, so no HTMLElement-only API or brand is asserted.
		const target = event.target as Element;
		if (["INPUT", "TEXTAREA"].includes(target.tagName)) {
			return;
		}
		const modifier = event.metaKey || event.ctrlKey;
		if (modifier && event.key.toLowerCase() === "z") {
			event.preventDefault();
			travel(event.shiftKey ? "redo" : "undo");
		} else if (
			(event.key === "Delete" || event.key === "Backspace") &&
			selectedId &&
			selectedId !== ROOT_NODE_ID
		) {
			event.preventDefault();
			apply([{ kind: "remove", nodeId: selectedId }], null);
		}
	};

	const onLayerDrop = (event: ReactDragEvent<HTMLElement>, overId: string) => {
		event.preventDefault();
		const box = event.currentTarget.getBoundingClientRect();
		const over = findNode(documentModel, overId);
		const where = dropPositionFor(
			event.clientY - box.top,
			box.height,
			Boolean(over && canContainChildren(over.tagName))
		);
		const nodeId =
			layerDrag.current ?? (event.dataTransfer.getData(NODE_MIME) || undefined);
		const block = event.dataTransfer.getData(BLOCK_MIME) || undefined;
		layerDrag.current = null;
		const operations = dropOperations({ node: nodeId, block }, overId, where);
		if (operations) {
			apply(operations, nodeId ?? null);
		}
	};

	const moveSelected = (delta: -1 | 1) => {
		if (!selectedId) {
			return;
		}
		const place = siblingPosition(documentModel, selectedId);
		if (!place) {
			return;
		}
		const next = place.index + delta;
		if (next < 0 || next >= place.count) {
			return;
		}
		apply(
			[
				{
					kind: "move",
					nodeId: selectedId,
					parentId: place.parentId,
					index: next,
				},
			],
			selectedId
		);
	};

	const insertBlock = (id: string) => {
		const block = visualBlock(id);
		if (!block) {
			return;
		}
		const target =
			selected && selectedId && selectedId !== ROOT_NODE_ID
				? resolveDrop(documentModel, null, selectedId, "after")
				: resolveDrop(documentModel, null, ROOT_NODE_ID, "inside");
		if (target) {
			apply([{ kind: "insertHtml", ...target, html: block.html }]);
		}
	};

	const selectedTag = selected?.tagName.toLowerCase() ?? "";
	// SAFETY: supported text/html HTML, SVG and MathML selections expose the native
	// inline-style mixin. Null retains the optional read; unsupported injected
	// elements retain the existing missing-style result rather than gaining a gate.
	const selectedStyle = (selected as (Element & ElementCSSInlineStyle) | null)
		?.style;
	const isLeaf = Boolean(
		selected && selected.children.length === 0 && selectedId !== ROOT_NODE_ID
	);
	const fieldKey = `${selectedId}:${working.length}:${past.length}`;

	return (
		<div
			className="grid min-w-0 shrink-0 gap-3 lg:min-h-[640px] lg:grid-cols-[220px_minmax(0,1fr)_280px]"
			data-testid="visual-editor"
			onKeyDown={onKeyDown}
		>
			<VisualEditorSidebar
				disabled={disabled}
				insertBlock={insertBlock}
				layerDrag={layerDrag}
				layers={layers}
				onLayerDrop={onLayerDrop}
				selectedId={selectedId}
				setSelectedId={setSelectedId}
				setTab={setTab}
				tab={tab}
			/>

			<section
				aria-label="Design canvas"
				className="flex min-w-0 flex-col gap-2"
			>
				<div className="flex flex-wrap items-center justify-between gap-2">
					<div className="flex gap-1">
						<Button
							disabled={disabled || past.length === 0}
							onClick={() => travel("undo")}
							size="sm"
							variant="outline"
						>
							Undo
						</Button>
						<Button
							disabled={disabled || future.length === 0}
							onClick={() => travel("redo")}
							size="sm"
							variant="outline"
						>
							Redo
						</Button>
					</div>
					<div aria-label="Canvas width" className="flex gap-1" role="group">
						{(["desktop", "tablet", "mobile"] as const).map((item) => (
							<Button
								aria-pressed={viewport === item}
								key={item}
								onClick={() => setViewport(item)}
								size="sm"
								variant={viewport === item ? "secondary" : "ghost"}
							>
								{item.charAt(0).toUpperCase() + item.slice(1)}
							</Button>
						))}
					</div>
				</div>
				<p className="text-muted-foreground text-xs">
					Click to select, double-click text to edit, drag to rearrange. Scripts
					are paused while designing; use Preview to try them.
				</p>
				<iframe
					className={cn(
						"mx-auto min-h-[480px] w-full flex-1 rounded-lg border bg-white lg:min-h-[600px]",
						styles.canvas
					)}
					onLoad={bindCanvas}
					ref={frameRef}
					sandbox={CANVAS_SANDBOX}
					srcDoc={canvas}
					style={
						{
							"--visual-canvas-width":
								VIEWPORT_WIDTH[viewport] === undefined
									? undefined
									: `${VIEWPORT_WIDTH[viewport]}px`,
						} satisfies VisualLayoutStyle as VisualLayoutStyle
					}
					title="Design canvas"
				/>
			</section>

			<aside
				aria-label="Inspector and chat"
				className="flex flex-col gap-3 lg:min-h-0"
			>
				<section className="flex flex-col gap-2 rounded-lg border p-3">
					<h3 className="font-medium text-sm">Ask Ryu</h3>
					<Label className="sr-only" htmlFor="visual-editor-chat">
						Describe a change
					</Label>
					<Textarea
						className="min-h-24"
						disabled={disabled || chatBusy || !complete}
						id="visual-editor-chat"
						maxLength={4000}
						onChange={(event) => setRequest(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
								event.preventDefault();
								void runChat();
							}
						}}
						placeholder={
							selected
								? tl("Change the selected {tag}…", { tag: `<${selectedTag}>` })
								: "Describe a change to the page…"
						}
						value={request}
					/>
					<Button
						disabled={disabled || chatBusy || !complete || !request.trim()}
						onClick={() => void runChat()}
						size="sm"
					>
						{chatBusy ? "Editing…" : "Apply"}
					</Button>
					{complete ? null : (
						<p className="text-muted-foreground text-xs">
							Connect a Ryu model to edit with chat.
						</p>
					)}
					{message ? (
						<p
							className={`text-xs ${message.tone === "error" ? "text-destructive" : "text-status-success"}`}
							role={message.tone === "error" ? "alert" : "status"}
						>
							{message.text}
						</p>
					) : null}
				</section>

				<VisualEditorInspector
					apply={apply}
					disabled={disabled}
					fieldKey={fieldKey}
					isLeaf={isLeaf}
					moveSelected={moveSelected}
					selected={selected}
					selectedId={selectedId}
					selectedStyle={selectedStyle}
					selectedTag={selectedTag}
				/>
			</aside>
		</div>
	);
}
