"use client";

import { useDraggable } from "@platejs/dnd";
import { Image, ImagePlugin, useMediaState } from "@platejs/media/react";
import { ResizableProvider, useResizableValue } from "@platejs/resizable";
import { cn } from "@ryu/ui/lib/utils.ts";
import type { TImageElement } from "platejs";
import type { PlateElementProps } from "platejs/react";
import { PlateElement, withHOC } from "platejs/react";

import { Caption, CaptionTextarea } from "./caption.tsx";
import { MediaToolbar } from "./media-toolbar.tsx";
import {
	mediaResizeHandleVariants,
	Resizable,
	ResizeHandle,
} from "./resize-handle.tsx";

export const ImageElement = withHOC(
	ResizableProvider,
	function ImageElement(props: PlateElementProps<TImageElement>) {
		const { align = "center", focused, readOnly, selected } = useMediaState();
		const width = useResizableValue("width");

		const { isDragging, handleRef } = useDraggable({
			element: props.element,
		});

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
									alt={props.attributes.alt as string | undefined}
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

						<Caption align={align} style={{ width }}>
							<CaptionTextarea
								onFocus={(e) => {
									e.preventDefault();
								}}
								placeholder="Write a caption..."
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
