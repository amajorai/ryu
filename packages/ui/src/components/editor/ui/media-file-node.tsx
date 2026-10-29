"use client";

import { useMediaState } from "@platejs/media/react";
import { ResizableProvider } from "@platejs/resizable";
import { safeMediaUrl } from "@ryu/ui/lib/safe-media-url.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import { FileUp } from "lucide-react";
import type { TFileElement } from "platejs";
import type { PlateElementProps } from "platejs/react";
import { PlateElement, useReadOnly, withHOC } from "platejs/react";
import { Caption, CaptionTextarea } from "./caption.tsx";

export const FileElement = withHOC(
	ResizableProvider,
	function FileElement(props: PlateElementProps<TFileElement>) {
		const readOnly = useReadOnly();
		const { name, unsafeUrl } = useMediaState();
		const safeUrl = safeMediaUrl(unsafeUrl);

		return (
			<PlateElement className="my-px rounded-sm" {...props}>
				<a
					className={cn(
						"group relative m-0 flex cursor-pointer items-center rounded px-0.5 py-[3px] hover:bg-muted"
					)}
					contentEditable={false}
					download={name}
					href={safeUrl ?? undefined}
					rel="noopener noreferrer"
					role="button"
					target="_blank"
				>
					<div className={cn("flex items-center gap-1 p-1")}>
						<FileUp className="size-5" />
						<div>{name}</div>
					</div>

					<Caption align="left">
						<CaptionTextarea
							className="text-start"
							placeholder="Write a caption…"
							readOnly={readOnly}
						/>
					</Caption>
				</a>
				{props.children}
			</PlateElement>
		);
	}
);
