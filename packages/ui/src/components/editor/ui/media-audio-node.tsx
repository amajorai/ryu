"use client";

import { useMediaState } from "@platejs/media/react";
import { ResizableProvider } from "@platejs/resizable";
import { safeMediaUrl } from "@ryu/ui/lib/safe-media-url.ts";
import type { TAudioElement } from "platejs";
import type { PlateElementProps } from "platejs/react";
import { PlateElement, withHOC } from "platejs/react";
import editorStyles from "../editor-lint.module.css";
import { Caption, CaptionTextarea } from "./caption.tsx";

export const AudioElement = withHOC(
	ResizableProvider,
	function AudioElement(props: PlateElementProps<TAudioElement>) {
		const { align = "center", readOnly, unsafeUrl } = useMediaState();
		const safeUrl = safeMediaUrl(unsafeUrl);

		return (
			<PlateElement {...props} className="mb-1">
				<figure
					className="group relative cursor-default"
					contentEditable={false}
				>
					<div className={"h-16 rounded-sm"}>
						<audio className="size-full" controls src={safeUrl ?? undefined} />
					</div>

					<Caption align={align} className={editorStyles.editormediaAudioNode1}>
						<CaptionTextarea
							className="h-20"
							placeholder="Write a caption…"
							readOnly={readOnly}
						/>
					</Caption>
				</figure>
				{props.children}
			</PlateElement>
		);
	}
);
