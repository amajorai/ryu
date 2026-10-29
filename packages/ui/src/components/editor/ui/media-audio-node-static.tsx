import { safeMediaUrl } from "@ryu/ui/lib/safe-media-url.ts";
import { cn } from "@ryu/ui/lib/utils.ts";

import type { TAudioElement } from "platejs";
import type { SlateElementProps } from "platejs/static";

import { SlateElement } from "platejs/static";

export function AudioElementStatic(props: SlateElementProps<TAudioElement>) {
	const safeUrl = safeMediaUrl(props.element.url);
	return (
		<SlateElement {...props} className="mb-1">
			<figure className="group relative cursor-default">
				<div className={cn("h-16 rounded-sm")}>
					<audio className="size-full" controls src={safeUrl ?? undefined} />
				</div>
			</figure>
			{props.children}
		</SlateElement>
	);
}
