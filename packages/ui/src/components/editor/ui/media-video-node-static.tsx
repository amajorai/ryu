import { isNativeNumber } from "@ryu/ui/lib/native-primitive-observation.ts";
import type { CSSProperties as ReactCSSProperties } from "react";
import "../docx-nodes.css";
import { safeMediaUrl } from "@ryu/ui/lib/safe-media-url.ts";
import type { TCaptionElement, TResizableProps, TVideoElement } from "platejs";
import { NodeApi } from "platejs";
import type { SlateElementProps } from "platejs/static";
import { SlateElement } from "platejs/static";

interface EditorVariableStyle extends ReactCSSProperties {
	"--editormediaVideoNodeStatic1-text-align"?: string | number;
	"--editormediaVideoNodeStatic2-width"?: string | number;
}

export function VideoElementStatic(
	props: SlateElementProps<TVideoElement & TCaptionElement & TResizableProps>
) {
	const { align = "center", caption, url, width } = props.element;
	const safeUrl = safeMediaUrl(url);

	const editormediaVideoNodeStatic1Style: EditorVariableStyle = {
		"--editormediaVideoNodeStatic1-text-align": align,
	};
	const editormediaVideoNodeStatic2Style: EditorVariableStyle = {
		"--editormediaVideoNodeStatic2-width": isNativeNumber(width)
			? `${width}px`
			: width,
	};
	return (
		<SlateElement className="py-2.5" {...props}>
			<div
				data-docx-style="editormediaVideoNodeStatic1"
				style={editormediaVideoNodeStatic1Style}
			>
				<figure
					className={"group relative m-0 inline-block cursor-default"}
					data-docx-style="editormediaVideoNodeStatic2"
					style={editormediaVideoNodeStatic2Style}
				>
					<div>
						<video
							className="w-full max-w-full rounded-sm object-cover px-0"
							controls
							src={safeUrl ?? undefined}
						/>
					</div>
					{caption?.[0] && (
						<figcaption>{NodeApi.string(caption[0])}</figcaption>
					)}
				</figure>
			</div>
			{props.children}
		</SlateElement>
	);
}
