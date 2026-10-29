import {
	Badge,
	Button,
	Input,
	Label,
	Textarea,
} from "@ryu/blocks/companion/controls";
import { cn } from "@ryu/ui/lib/utils.ts";
import type { CSSProperties } from "react";
import {
	type DragEvent as ReactDragEvent,
	type KeyboardEvent as ReactKeyboardEvent,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { VISUAL_BLOCKS, visualBlock } from "./blocks.ts";
import {
	CANVAS_SANDBOX,
	canvasDocument,
	DROP_ATTRIBUTE,
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
	NODE_ATTRIBUTE,
	outline,
	prepareHtml,
	ROOT_NODE_ID,
	resolveDrop,
	siblingPosition,
	type VisualOperation,
} from "./core.ts";
import styles from "./visual-editor.module.css";

const NODE_MIME = "application/x-ryu-node";
const BLOCK_MIME = "application/x-ryu-block";
const MAX_HISTORY = 50;

export type VisualEditorComplete = (input: {
	prompt: string;
	system: string;
}) => Promise<string>;

export interface VisualEditorProps {
	/** The host model, when one is connected. Chat is disabled without it. */
	complete?: VisualEditorComplete;
	disabled?: boolean;
	/** Clean HTML from the host. A change from outside resets history. */
	html: string;
	/** Receives clean HTML (no editor ids) after every successful edit. */
	onChange: (html: string) => void;
}

type Viewport = "desktop" | "tablet" | "mobile";
const VIEWPORT_WIDTH = {
	desktop: undefined,
	tablet: 820,
	mobile: 390,
} satisfies Record<Viewport, number | undefined>;

const STYLE_FIELDS = [
	["color", "Text color"],
	["background-color", "Background"],
	["font-size", "Font size"],
	["font-weight", "Font weight"],
	["text-align", "Alignment"],
	["padding", "Padding"],
	["margin", "Margin"],
	["gap", "Gap"],
	["border-radius", "Corner radius"],
	["width", "Width"],
	["max-width", "Max width"],
] as const;

const ATTRIBUTE_FIELDS = {
	a: [
		["href", "Link"],
		["aria-label", "Accessible label"],
	],
	img: [
		["src", "Image source"],
		["alt", "Alt text"],
	],
	button: [["aria-label", "Accessible label"]],
	input: [
		["placeholder", "Placeholder"],
		["aria-label", "Accessible label"],
	],
} satisfies Record<string, readonly (readonly [string, string])[]>;

interface VisualLayoutStyle extends CSSProperties {
	"--visual-canvas-width"?: string;
	"--visual-layer-indent"?: string;
}
function attributeFields(tag: string) {
	switch (tag) {
		case "a":
			return ATTRIBUTE_FIELDS.a;
		case "img":
			return ATTRIBUTE_FIELDS.img;
		case "button":
			return ATTRIBUTE_FIELDS.button;
		case "input":
			return ATTRIBUTE_FIELDS.input;
		default:
			return [];
	}
}

const parser = (): DOMParser => new DOMParser();

function nodeFromEvent(target: EventTarget | null): Element | null {
	// SAFETY: all five callers pass native DOM targets from this iframe Document.
	// nodeType 1 selects Element; other Nodes retain the parentElement fallback.
	const element =
		target && (target as Node).nodeType === 1
			? (target as Element)
			: ((target as Node | null)?.parentElement ?? null);
	return element?.closest(`[${NODE_ATTRIBUTE}]`) ?? null;
}

function clearDropMarks(document: Document | null | undefined): void {
	for (const element of document?.querySelectorAll(`[${DROP_ATTRIBUTE}]`) ??
		[]) {
		element.removeAttribute(DROP_ATTRIBUTE);
	}
}

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
		let dragSource: string | null = null;
		const position = (node: Element, clientY: number): DropPosition => {
			const box = node.getBoundingClientRect();
			return dropPositionFor(
				clientY - box.top,
				box.height,
				canContainChildren(node.tagName)
			);
		};
		frameDocument.addEventListener("click", (event) => {
			event.preventDefault();
			const node = nodeFromEvent(event.target);
			// SAFETY: the native HTML editing mixin may be absent on SVG/MathML.
			// This optional field view preserves that absent read and its negation.
			if (
				node &&
				!(node as Element & Partial<ElementContentEditable>).isContentEditable
			) {
				handlers.current.setSelectedId(node.getAttribute(NODE_ATTRIBUTE));
			}
		});
		frameDocument.addEventListener("dblclick", (event) => {
			// SAFETY: the parsed text/html canvas supplies native HTML, SVG or MathML
			// elements with focus/events; optional HTML editing fields preserve non-HTML
			// absent properties and the original assignments, without an HTML brand gate.
			const node = nodeFromEvent(event.target) as
				| (Element &
						Partial<ElementContentEditable> &
						HTMLOrSVGElement &
						GlobalEventHandlers)
				| null;
			const id = node?.getAttribute(NODE_ATTRIBUTE);
			if (!(node && id) || id === ROOT_NODE_ID || node.children.length > 0) {
				return;
			}
			const original = node.textContent ?? "";
			node.contentEditable = "true";
			node.focus();
			const finish = (save: boolean) => {
				node.contentEditable = "false";
				const text = node.textContent ?? "";
				if (save && text !== original) {
					handlers.current.apply([{ kind: "setText", nodeId: id, text }], id);
				} else {
					node.textContent = original;
				}
			};
			node.addEventListener("blur", () => finish(true), { once: true });
			node.addEventListener("keydown", (keyEvent: KeyboardEvent) => {
				if (keyEvent.key === "Enter" && !keyEvent.shiftKey) {
					keyEvent.preventDefault();
					node.blur();
				} else if (keyEvent.key === "Escape") {
					node.textContent = original;
					node.blur();
				}
			});
		});
		frameDocument.addEventListener("dragstart", (event) => {
			const node = nodeFromEvent(event.target);
			const id = node?.getAttribute(NODE_ATTRIBUTE);
			if (!(id && event.dataTransfer) || id === ROOT_NODE_ID) {
				event.preventDefault();
				return;
			}
			dragSource = id;
			event.dataTransfer.effectAllowed = "move";
			event.dataTransfer.setData(NODE_MIME, id);
		});
		frameDocument.addEventListener("dragend", () => {
			dragSource = null;
			clearDropMarks(frameDocument);
		});
		frameDocument.addEventListener("dragover", (event) => {
			const node = nodeFromEvent(event.target);
			const types = event.dataTransfer?.types ?? [];
			if (
				!(node && (types.includes(NODE_MIME) || types.includes(BLOCK_MIME)))
			) {
				return;
			}
			const where = position(node, event.clientY);
			const overId = node.getAttribute(NODE_ATTRIBUTE) ?? "";
			const allowed = handlers.current.dropOperations(
				dragSource ? { node: dragSource } : { block: "section" },
				overId,
				where
			);
			clearDropMarks(frameDocument);
			if (allowed) {
				event.preventDefault();
				node.setAttribute(
					DROP_ATTRIBUTE,
					overId === ROOT_NODE_ID ? "inside" : where
				);
			}
		});
		frameDocument.addEventListener("dragleave", (event) => {
			if (event.target === frameDocument.documentElement) {
				clearDropMarks(frameDocument);
			}
		});
		frameDocument.addEventListener("drop", (event) => {
			event.preventDefault();
			clearDropMarks(frameDocument);
			const node = nodeFromEvent(event.target);
			const overId = node?.getAttribute(NODE_ATTRIBUTE);
			if (!(node && overId && event.dataTransfer)) {
				return;
			}
			const nodeId = event.dataTransfer.getData(NODE_MIME) || undefined;
			const block = event.dataTransfer.getData(BLOCK_MIME) || undefined;
			const operations = handlers.current.dropOperations(
				{ node: nodeId, block },
				overId,
				position(node, event.clientY)
			);
			if (operations) {
				handlers.current.apply(operations, nodeId ?? null);
			}
		});
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
					text: `${parsed.summary} Undo is available.`,
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
								? `Change the selected <${selectedTag}>…`
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

				<section
					aria-label="Inspector"
					className="flex flex-col gap-2 rounded-lg border p-3"
				>
					{selected && selectedId ? (
						<>
							<div className="flex items-center justify-between gap-2">
								<h3 className="font-medium text-sm">Selected</h3>
								<Badge variant="outline">
									{selectedId === ROOT_NODE_ID ? "page" : `<${selectedTag}>`}
								</Badge>
							</div>
							{selectedId === ROOT_NODE_ID ? null : (
								<div className="flex flex-wrap gap-1">
									<Button
										disabled={disabled}
										onClick={() => moveSelected(-1)}
										size="sm"
										variant="outline"
									>
										Move up
									</Button>
									<Button
										disabled={disabled}
										onClick={() => moveSelected(1)}
										size="sm"
										variant="outline"
									>
										Move down
									</Button>
									<Button
										disabled={disabled}
										onClick={() =>
											apply([{ kind: "duplicate", nodeId: selectedId }])
										}
										size="sm"
										variant="outline"
									>
										Duplicate
									</Button>
									<Button
										disabled={disabled}
										onClick={() =>
											apply([{ kind: "remove", nodeId: selectedId }], null)
										}
										size="sm"
										variant="outline"
									>
										Delete
									</Button>
								</div>
							)}
							{isLeaf ? (
								<InspectorField
									defaultValue={selected.textContent ?? ""}
									disabled={disabled}
									key={`text:${fieldKey}`}
									label="Text"
									multiline
									onCommit={(text) =>
										apply(
											[{ kind: "setText", nodeId: selectedId, text }],
											selectedId
										)
									}
								/>
							) : null}
							{attributeFields(selectedTag).map(([name, label]) => (
								<InspectorField
									defaultValue={selected.getAttribute(name) ?? ""}
									disabled={disabled}
									key={`${name}:${fieldKey}`}
									label={label}
									onCommit={(value) =>
										apply(
											[
												{
													kind: "setAttribute",
													nodeId: selectedId,
													name,
													value: value || null,
												},
											],
											selectedId
										)
									}
								/>
							))}
							<details>
								<summary className="cursor-pointer text-sm">Style</summary>
								<div className="mt-2 flex flex-col gap-2">
									{STYLE_FIELDS.map(([property, label]) => (
										<InspectorField
											defaultValue={
												selectedStyle?.getPropertyValue(property) ?? ""
											}
											disabled={disabled}
											key={`${property}:${fieldKey}`}
											label={label}
											onCommit={(value) =>
												apply(
													[
														{
															kind: "setStyle",
															nodeId: selectedId,
															property,
															value: value || null,
														},
													],
													selectedId
												)
											}
										/>
									))}
								</div>
							</details>
						</>
					) : (
						<p className="text-muted-foreground text-sm">
							Select something on the page to edit it.
						</p>
					)}
				</section>
			</aside>
		</div>
	);
}

function InspectorField({
	defaultValue,
	disabled,
	label,
	multiline = false,
	onCommit,
}: {
	defaultValue: string;
	disabled: boolean;
	label: string;
	multiline?: boolean;
	onCommit: (value: string) => void;
}) {
	const [value, setValue] = useState(defaultValue);
	const id = `visual-field-${label.toLowerCase().replace(/\W+/g, "-")}`;
	const commit = () => {
		if (value !== defaultValue) {
			onCommit(value);
		}
	};
	return (
		<div className="flex flex-col gap-1">
			<Label htmlFor={id} size="compact">
				{label}
			</Label>
			{multiline ? (
				<Textarea
					className="min-h-16"
					disabled={disabled}
					id={id}
					onBlur={commit}
					onChange={(event) => setValue(event.target.value)}
					value={value}
				/>
			) : (
				<Input
					className="h-8"
					disabled={disabled}
					id={id}
					onBlur={commit}
					onChange={(event) => setValue(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Enter") {
							event.preventDefault();
							commit();
						}
					}}
					value={value}
				/>
			)}
		</div>
	);
}
