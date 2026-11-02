"use client";

import type {
	CodeDrawingType,
	TCodeDrawingElement,
	ViewMode,
} from "@platejs/code-drawing";
import {
	CODE_DRAWING_TYPE_ARRAY,
	DEFAULT_MIN_HEIGHT,
	DOWNLOAD_FILENAME,
	downloadImage,
	RENDER_DEBOUNCE_DELAY,
	renderCodeDrawing,
	VIEW_MODE,
	VIEW_MODE_ARRAY,
} from "@platejs/code-drawing";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/editor/ui/button.tsx";
import {
	Popover,
	PopoverAnchor,
	PopoverContent,
} from "@ryu/ui/components/editor/ui/popover.tsx";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/editor/ui/select.tsx";
import { useIsMobile } from "@ryu/ui/hooks/use-mobile.ts";
import { isNativeNumber } from "@ryu/ui/lib/native-primitive-observation.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import debounce from "lodash/debounce.js";
import { DownloadIcon, Trash2 } from "lucide-react";
import type { PlateElementProps } from "platejs/react";
import {
	PlateElement,
	useEditorRef,
	useEditorSelector,
	useElement,
	useFocusedLast,
	useReadOnly,
	useSelected,
} from "platejs/react";
import {
	type ChangeEvent,
	type Dispatch,
	type SetStateAction,
	useCallback,
	useEffect,
	useMemo,
	useState,
} from "react";
import editorStyles from "../editor-lint.module.css";
import {
	CodeDrawingPreviewArea,
	CodeDrawingTextarea,
	type EditorVariableStyle,
} from "./code-drawing-panes.tsx";

function createDebouncedCodeDrawingRenderer(
	setImage: Dispatch<SetStateAction<string>>,
	setLoading: Dispatch<SetStateAction<boolean>>,
	setError: Dispatch<SetStateAction<string | null>>
) {
	let lastRequestId = 0;

	return debounce(
		async (
			code: string | undefined,
			drawingType: CodeDrawingType | undefined
		) => {
			lastRequestId += 1;
			const requestId = lastRequestId;

			if (!(code?.trim() && drawingType)) {
				setImage("");
				setLoading(false);
				setError(null);
				return;
			}

			setLoading(true);
			setError(null);

			try {
				const imageData = await renderCodeDrawing(drawingType, code);

				if (lastRequestId === requestId) {
					setImage(imageData);
					setError(null);
				}
			} catch (err) {
				if (lastRequestId === requestId) {
					setError(err instanceof Error ? err.message : "Rendering failed");
					setImage("");
				}
			} finally {
				if (lastRequestId === requestId) {
					setLoading(false);
				}
			}
		},
		RENDER_DEBOUNCE_DELAY
	);
}

function useCodeDrawingElement({ element }: { element: TCodeDrawingElement }) {
	const editor = useEditorRef();
	const readOnly = useReadOnly();
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [image, setImage] = useState<string>("");

	const debouncedRender = useMemo(
		() => createDebouncedCodeDrawingRenderer(setImage, setLoading, setError),
		[]
	);

	useEffect(() => {
		debouncedRender(element.data?.code, element.data?.drawingType);

		return () => {
			debouncedRender.cancel();
		};
	}, [element.data?.code, element.data?.drawingType, debouncedRender]);

	const removeNode = () => {
		if (readOnly) {
			return;
		}

		const path = editor.api.findPath(element);
		if (path) {
			editor.tf.removeNodes({ at: path });
		}
	};

	return {
		loading,
		error,
		image,
		removeNode,
	};
}

export function CodeDrawingElement(
	props: PlateElementProps<TCodeDrawingElement>
) {
	const { children } = props;
	const isMobile = useIsMobile();
	const editor = useEditorRef();
	const readOnly = useReadOnly();
	const selected = useSelected();
	const isFocusedLast = useFocusedLast();
	const element = useElement<TCodeDrawingElement>();
	const { removeNode, image, loading } = useCodeDrawingElement({ element });
	const tl = useLiteralMessages();

	const handleDownload = useCallback(() => {
		if (!image) {
			return;
		}
		downloadImage(image, DOWNLOAD_FILENAME);
	}, [image]);

	const handleCodeChange = useCallback(
		(code: string) => {
			const path = editor.api.findPath(element);
			if (path) {
				editor.tf.setNodes(
					{
						data: {
							...element.data,
							code,
						},
					},
					{ at: path }
				);
			}
		},
		[editor, element]
	);

	const handleDrawingTypeChange = useCallback(
		(drawingType: CodeDrawingType) => {
			const path = editor.api.findPath(element);
			if (path) {
				editor.tf.setNodes(
					{
						data: {
							...element.data,
							drawingType,
						},
					},
					{ at: path }
				);
			}
		},
		[editor, element]
	);

	const handleDrawingModeChange = useCallback(
		(drawingMode: ViewMode) => {
			const path = editor.api.findPath(element);
			if (path) {
				editor.tf.setNodes(
					{
						data: {
							...element.data,
							drawingMode,
						},
					},
					{ at: path }
				);
			}
		},
		[editor, element]
	);

	const code = element.data?.code ?? "";
	const drawingType = element.data?.drawingType ?? "Mermaid";
	const drawingMode = element.data?.drawingMode ?? "Both";

	const selectionCollapsed = useEditorSelector(
		(editor) => !editor.api.isExpanded(),
		[]
	);

	const open = isFocusedLast && !readOnly && selected && selectionCollapsed;

	const content = (
		<PlateElement {...props}>
			<div contentEditable={false}>
				<div>
					<CodeDrawingPreview
						code={code}
						drawingMode={drawingMode}
						drawingType={drawingType}
						image={image}
						isMobile={isMobile}
						loading={loading}
						onCodeChange={handleCodeChange}
						onDrawingModeChange={handleDrawingModeChange}
						onDrawingTypeChange={handleDrawingTypeChange}
						readOnly={readOnly}
					/>
				</div>
			</div>
			{children}
		</PlateElement>
	);

	if (readOnly) {
		return content;
	}

	return (
		<Popover modal={false} open={open}>
			<PopoverAnchor>{content}</PopoverAnchor>
			<PopoverContent
				className="w-auto p-1"
				contentEditable={false}
				onOpenAutoFocus={(e) => e.preventDefault()}
			>
				<div className="flex items-center gap-1">
					{image && (
						<Button
							className="size-8"
							onClick={handleDownload}
							size="icon"
							title={tl("Export")}
							variant="ghost"
						>
							<DownloadIcon className="size-4" />
						</Button>
					)}
					<Button
						className="size-8"
						onClick={removeNode}
						size="icon"
						title={tl("Delete")}
						variant="ghost"
					>
						<Trash2 className="size-4" />
					</Button>
				</div>
			</PopoverContent>
		</Popover>
	);
}

function CodeDrawingPreview({
	code,
	drawingType,
	drawingMode,
	image,
	loading,
	onCodeChange,
	onDrawingTypeChange,
	onDrawingModeChange,
	readOnly = false,
	isMobile = false,
}: {
	code: string;
	drawingType: CodeDrawingType;
	drawingMode: ViewMode;
	image: string;
	loading: boolean;
	onCodeChange: (code: string) => void;
	onDrawingTypeChange: (type: CodeDrawingType) => void;
	onDrawingModeChange: (mode: ViewMode) => void;
	readOnly?: boolean;
	isMobile?: boolean;
}) {
	const viewMode = drawingMode;
	const showCode = viewMode === VIEW_MODE.Both || viewMode === VIEW_MODE.Code;
	const showBorder = viewMode === VIEW_MODE.Both;

	const handleCodeChange = useCallback(
		(e: ChangeEvent<HTMLTextAreaElement>) => {
			onCodeChange(e.target.value);
		},
		[onCodeChange]
	);

	const toolbar = readOnly ? null : (
		<CodeDrawingToolbar
			drawingType={drawingType}
			isMobile={isMobile}
			onDrawingModeChange={onDrawingModeChange}
			onDrawingTypeChange={onDrawingTypeChange}
			readOnly={readOnly}
			viewMode={viewMode}
		/>
	);

	const editorcodeDrawingNode1Style: EditorVariableStyle = {
		"--editorcodeDrawingNode1-min-height": isNativeNumber(
			`${DEFAULT_MIN_HEIGHT}px`
		)
			? `${`${DEFAULT_MIN_HEIGHT}px`}px`
			: `${DEFAULT_MIN_HEIGHT}px`,
	};
	return (
		<div
			className={cn(
				`flex ${isMobile ? "flex-col-reverse" : "flex-col"} group my-4 w-full items-stretch border bg-muted/50 md:flex-row`,
				editorStyles.editorcodeDrawingNode1
			)}
			style={editorcodeDrawingNode1Style}
		>
			{showCode && (
				<CodeDrawingTextarea
					code={code}
					isMobile={isMobile}
					onCodeChange={handleCodeChange}
					readOnly={readOnly}
					showBorder={showBorder}
					toolbar={viewMode === VIEW_MODE.Code ? toolbar : null}
					viewMode={viewMode}
				/>
			)}

			{viewMode !== VIEW_MODE.Code && (
				<CodeDrawingPreviewArea
					code={code}
					image={image}
					isMobile={isMobile}
					loading={loading}
					readOnly={readOnly}
					showBorder={showBorder}
					toolbar={toolbar}
					viewMode={viewMode}
				/>
			)}
		</div>
	);
}

function CodeDrawingToolbar({
	drawingType,
	viewMode,
	readOnly = false,
	isMobile = false,
	onDrawingTypeChange,
	onDrawingModeChange,
}: {
	drawingType: CodeDrawingType;
	viewMode: ViewMode;
	readOnly?: boolean;
	isMobile?: boolean;
	onDrawingTypeChange: (type: CodeDrawingType) => void;
	onDrawingModeChange: (mode: ViewMode) => void;
}) {
	const [toolbarVisible, setToolbarVisible] = useState(false);
	const [languageSelectOpen, setLanguageSelectOpen] = useState(false);
	const [viewModeSelectOpen, setViewModeSelectOpen] = useState(false);

	const opacityClass =
		isMobile || toolbarVisible || languageSelectOpen || viewModeSelectOpen
			? "opacity-100"
			: "opacity-0 group-hover:opacity-100";

	const positionClass = isMobile
		? "flex items-center gap-2"
		: "absolute right-2 z-10 flex items-center gap-2";

	return (
		<div
			className={`${positionClass} transition-opacity ${opacityClass}`}
			onMouseEnter={() => setToolbarVisible(true)}
			onMouseLeave={() => {
				if (!(languageSelectOpen || viewModeSelectOpen)) {
					setToolbarVisible(false);
				}
			}}
			role="toolbar"
		>
			{!readOnly && (
				<Select
					onOpenChange={setLanguageSelectOpen}
					onValueChange={onDrawingTypeChange}
					open={languageSelectOpen}
					value={drawingType}
				>
					<SelectTrigger
						className={`h-8 w-[120px] border-0 bg-muted/50 text-xs shadow-none ${
							isMobile ? "" : "transition-colors hover:bg-input"
						}`}
					>
						<SelectValue />
					</SelectTrigger>
					<SelectContent className="z-[100]">
						{CODE_DRAWING_TYPE_ARRAY.map((item) => (
							<SelectItem key={item.value} value={item.value}>
								{item.label}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			)}

			{!readOnly && (
				<Select
					onOpenChange={setViewModeSelectOpen}
					onValueChange={onDrawingModeChange}
					open={viewModeSelectOpen}
					value={viewMode}
				>
					<SelectTrigger
						className={`h-8 w-[80px] border-0 bg-muted/50 text-xs shadow-none ${
							isMobile ? "" : "transition-colors hover:bg-input"
						}`}
					>
						<SelectValue />
					</SelectTrigger>
					<SelectContent className="z-[100]">
						{VIEW_MODE_ARRAY.map((item) => (
							<SelectItem key={item.value} value={item.value}>
								{item.label}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			)}
		</div>
	);
}
