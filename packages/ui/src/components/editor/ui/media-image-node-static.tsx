import {
	isNativeNumber,
	isNativeText,
} from "@ryu/ui/lib/native-primitive-observation.ts";
import type { CSSProperties as ReactCSSProperties } from "react";
import "../docx-nodes.css";
import { safeMediaUrl } from "@ryu/ui/lib/safe-media-url.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import type { TCaptionProps, TImageElement, TResizableProps } from "platejs";
import { NodeApi } from "platejs";
import type { SlateElementProps } from "platejs/static";
import { SlateElement } from "platejs/static";

interface EditorVariableStyle extends ReactCSSProperties {
	"--editormediaImageNodeStatic1-width"?: string | number;
	"--editormediaImageNodeStatic2-text-align"?: string | number;
}

export function ImageElementStatic(
	props: SlateElementProps<TImageElement & TCaptionProps & TResizableProps>
) {
	const { align = "center", caption, url, width } = props.element;
	const safeUrl = safeMediaUrl(url);

	const editormediaImageNodeStatic1Style: EditorVariableStyle = {
		"--editormediaImageNodeStatic1-width": isNativeNumber(width)
			? `${width}px`
			: width,
	};
	const editormediaImageNodeStatic2Style: EditorVariableStyle = {
		"--editormediaImageNodeStatic2-text-align": align,
	};
	return (
		<SlateElement {...props} className="py-2.5">
			<figure
				className={"group relative m-0 inline-block"}
				data-docx-style="editormediaImageNodeStatic1"
				style={editormediaImageNodeStatic1Style}
			>
				<div
					className={"relative min-w-[92px] max-w-full"}
					data-docx-style="editormediaImageNodeStatic2"
					style={editormediaImageNodeStatic2Style}
				>
					<div>
						<img
							alt={
								isNativeText(props.attributes.alt)
									? props.attributes.alt
									: undefined
							}
							className={cn(
								"w-full max-w-full cursor-default object-cover px-0",
								"rounded-sm"
							)}
							src={safeUrl ?? undefined}
						/>
					</div>
					{caption?.[0] && (
						<figcaption
							className={"mx-auto mt-2 h-[24px] max-w-full"}
							data-docx-style="editormediaImageNodeStatic3"
						>
							{NodeApi.string(caption[0])}
						</figcaption>
					)}
				</div>
			</figure>
			{props.children}
		</SlateElement>
	);
}
