import { ChevronRight } from "lucide-react";

import type { SlateElementProps } from "platejs/static";
import { SlateElement } from "platejs/static";

export function ToggleElementStatic(props: SlateElementProps) {
	return (
		<SlateElement {...props} className="ps-6">
			<div
				className="absolute -start-0.5 top-0 size-6 cursor-pointer select-none items-center justify-center rounded-md p-px text-muted-foreground transition-colors hover:bg-accent [&_svg]:size-4"
				contentEditable={false}
			>
				<ChevronRight className="rotate-0 transition-transform duration-75 rtl:-scale-x-100" />
			</div>
			{props.children}
		</SlateElement>
	);
}
