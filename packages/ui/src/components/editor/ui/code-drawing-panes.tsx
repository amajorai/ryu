"use client";

// The code-drawing node's two panes: the source textarea and the rendered
// preview. Both sit inside the editable, so their copy goes through tl().

import type { ViewMode } from "@platejs/code-drawing";
import { DEFAULT_MIN_HEIGHT, VIEW_MODE } from "@platejs/code-drawing";
import { useLiteralMessages } from "@ryu/i18n/react";
import { isNativeNumber } from "@ryu/ui/lib/native-primitive-observation.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import {
	type ChangeEvent,
	type CSSProperties as ReactCSSProperties,
	type ReactNode,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import editorStyles from "../editor-lint.module.css";

export interface EditorVariableStyle extends ReactCSSProperties {
	"--editorcodeDrawingNode1-min-height"?: string | number;
	"--editorcodeDrawingNode2-min-height"?: string | number;
	"--editorcodeDrawingNode3-min-height"?: string | number;
}

export function CodeDrawingTextarea({
	code,
	viewMode,
	readOnly = false,
	isMobile = false,
	showBorder = false,
	onCodeChange,
	toolbar,
}: {
	code: string;
	viewMode: ViewMode;
	readOnly?: boolean;
	isMobile?: boolean;
	showBorder?: boolean;
	onCodeChange: (e: ChangeEvent<HTMLTextAreaElement>) => void;
	toolbar?: ReactNode;
}) {
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const tl = useLiteralMessages();
	const isCodeOnlyMode = viewMode === VIEW_MODE.Code;

	const [internalCode, setInternalCode] = useState(code);
	const lastExternalCodeRef = useRef(code);

	useEffect(() => {
		if (code !== lastExternalCodeRef.current) {
			lastExternalCodeRef.current = code;
			setInternalCode(code);
		}
	}, [code]);

	const handleChange = useCallback(
		(e: ChangeEvent<HTMLTextAreaElement>) => {
			const newValue = e.target.value;
			setInternalCode(newValue);
			onCodeChange(e);
		},
		[onCodeChange]
	);

	const editorcodeDrawingNode2Style: EditorVariableStyle = {
		"--editorcodeDrawingNode2-min-height": isNativeNumber(
			`${DEFAULT_MIN_HEIGHT}px`
		)
			? `${`${DEFAULT_MIN_HEIGHT}px`}px`
			: `${DEFAULT_MIN_HEIGHT}px`,
	};
	const editorcodeDrawingNode3Style: EditorVariableStyle = {
		"--editorcodeDrawingNode3-min-height": isNativeNumber(
			`${DEFAULT_MIN_HEIGHT}px`
		)
			? `${`${DEFAULT_MIN_HEIGHT}px`}px`
			: `${DEFAULT_MIN_HEIGHT}px`,
	};
	return (
		<div
			className={`${
				isCodeOnlyMode ? "w-full" : "min-w-0 flex-1"
			} flex flex-col ${isCodeOnlyMode && !isMobile ? "relative" : ""} ${
				showBorder && !isMobile ? "border-r" : ""
			}`}
		>
			{toolbar && isCodeOnlyMode && (
				<div
					className={
						isMobile
							? "mt-2 mb-2 flex justify-end px-2"
							: "absolute right-2 z-10 mt-2"
					}
				>
					{toolbar}
				</div>
			)}

			<div className="relative flex-1 rounded-md">
				<pre
					className={cn(
						"m-0 overflow-x-auto p-8 pr-4 font-mono text-sm leading-[normal] [tab-size:2] print:break-inside-avoid",
						editorStyles.editorcodeDrawingNode2
					)}
					style={editorcodeDrawingNode2Style}
				>
					<code className="block h-full w-full">
						<textarea
							className={cn(
								"m-0 h-full w-full resize-none overflow-auto border-0 bg-transparent p-0 font-mono text-sm outline-none",
								editorStyles.editorcodeDrawingNode3
							)}
							onChange={handleChange}
							placeholder={tl("Enter your code here…")}
							readOnly={readOnly}
							ref={textareaRef}
							spellCheck={false}
							style={editorcodeDrawingNode3Style}
							value={internalCode}
						/>
					</code>
				</pre>
			</div>
		</div>
	);
}

export function CodeDrawingPreviewArea({
	image,
	loading,
	code,
	viewMode,
	readOnly: _readOnly = false,
	isMobile = false,
	showBorder = false,
	toolbar,
}: {
	image: string;
	loading: boolean;
	code: string;
	viewMode: ViewMode;
	readOnly?: boolean;
	isMobile?: boolean;
	showBorder?: boolean;
	toolbar?: ReactNode;
}) {
	const showImage = viewMode === VIEW_MODE.Both || viewMode === VIEW_MODE.Image;
	const tl = useLiteralMessages();

	return (
		<div
			className={`flex min-w-0 flex-1 flex-col ${isMobile ? "" : "relative"} ${
				showBorder && isMobile ? "border-b" : ""
			}`}
		>
			{toolbar && (
				<div
					className={
						isMobile
							? "mt-2 mb-2 flex justify-end px-2"
							: "absolute right-2 z-10 mt-2"
					}
				>
					{toolbar}
				</div>
			)}

			{showImage ? (
				<div
					className={
						"flex flex-1 items-center justify-center rounded-md bg-muted/30 p-4"
					}
				>
					{loading && (
						<div className="text-muted-foreground">{tl("Loading…")}</div>
					)}
					{!loading && image && (
						<img
							alt={tl("Code drawing")}
							className="max-h-full max-w-full object-contain"
							src={image}
						/>
					)}
					{!(loading || image) && (
						<div className="text-muted-foreground">
							{code.trim() ? tl("Rendering…") : tl("Preview will appear here")}
						</div>
					)}
				</div>
			) : (
				<div className="pointer-events-none flex flex-1 items-center justify-center rounded-md border bg-muted/30 p-4 opacity-0">
					{/* Placeholder to maintain height */}
				</div>
			)}
		</div>
	);
}
