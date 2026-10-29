"use client";

import { useDraggable } from "@platejs/dnd";
import { Image, ImagePlugin, useMediaState } from "@platejs/media/react";
import { ResizableProvider, useResizableValue } from "@platejs/resizable";
import {
	isNativeNumber,
	isNativeText,
} from "@ryu/ui/lib/native-primitive-observation.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import type { TImageElement } from "platejs";
import type { PlateElementProps } from "platejs/react";
import { PlateElement, withHOC } from "platejs/react";
import type { CSSProperties as ReactCSSProperties } from "react";
import editorStyles from "../editor-lint.module.css";
import { Caption, CaptionTextarea } from "./caption.tsx";
import { MediaToolbar } from "./media-toolbar.tsx";
import {
	mediaResizeHandleVariants,
	Resizable,
	ResizeHandle,
} from "./resize-handle.tsx";

interface EditorVariableStyle extends ReactCSSProperties {
	"--editormediaImageNode1-width"?: string | number;
}

export const ImageElement = withHOC(
	ResizableProvider,
	function ImageElement(props: PlateElementProps<TImageElement>) {
		const { align = "center", focused, readOnly, selected } = useMediaState();
		const width = useResizableValue("width");

		const { isDragging, handleRef } = useDraggable({
			element: props.element,
		});

		const editormediaImageNode1Style: EditorVariableStyle = {
			"--editormediaImageNode1-width": isNativeNumber(width)
				? `${width}px`
				: width,
		};
		return (
			<MediaToolbar plugin={ImagePlugin}>
				<PlateElement {...props} className="py-2.5">
					<figure className="group relative m-0" contentEditable={false}>
						<Resizable
							align={align}
							options={{
								align,
								readOnly,
							}}
						>
							<ResizeHandle
								className={mediaResizeHandleVariants({ direction: "left" })}
								options={{ direction: "left" }}
							/>
							<div>
								<Image
									alt={
										isNativeText(props.attributes.alt)
											? props.attributes.alt
											: undefined
									}
									className={cn(
										"block w-full max-w-full cursor-pointer object-cover px-0",
										"rounded-sm",
										focused && selected && "ring-2 ring-ring ring-offset-2",
										isDragging && "opacity-50"
									)}
									ref={handleRef}
								/>
							</div>
							<ResizeHandle
								className={mediaResizeHandleVariants({
									direction: "right",
								})}
								options={{ direction: "right" }}
							/>
						</Resizable>

						<Caption
							align={align}
							className={editorStyles.editormediaImageNode1}
							style={editormediaImageNode1Style}
						>
							<CaptionTextarea
								onFocus={(e) => {
									e.preventDefault();
								}}
								placeholder="Write a caption…"
								readOnly={readOnly}
							/>
						</Caption>
					</figure>

					{props.children}
				</PlateElement>
			</MediaToolbar>
		);
	}
);
