import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import type { ComponentType } from "react";

/** Props an icon slot passes to its component (`className`, aria). */
export interface HugeiconComponentProps {
	"aria-hidden"?: boolean | "true" | "false";
	className?: string;
}

/**
 * Wrap a Hugeicons glyph as a component for slots typed as an icon component
 * (`icon: ComponentType<{ className?: string }>`), such as mention kinds and
 * source icons. JSX call sites render `<HugeiconsIcon icon={…} />` directly.
 */
export function hugeiconComponent(
	icon: IconSvgElement
): ComponentType<HugeiconComponentProps> {
	function HugeiconComponent(props: HugeiconComponentProps) {
		return <HugeiconsIcon icon={icon} {...props} />;
	}
	return HugeiconComponent;
}
