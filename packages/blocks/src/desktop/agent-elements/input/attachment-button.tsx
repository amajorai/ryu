import { Add01Icon, Attachment01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button";
import { memo, type ReactNode } from "react";

export type AttachmentButtonIcon = "plus" | "paperclip";

export interface AttachmentButtonProps {
	/**
	 * Icon to render inside the button.
	 * - "plus" (default): a `+` glyph, matches the generic "add something" affordance.
	 * - "paperclip": a paperclip glyph, matches the more literal "attach file" affordance.
	 * - Pass any ReactNode to fully override (e.g. a custom svg). The node is
	 *   rendered as-is inside the button; size/color from this component's
	 *   styling is only applied to the built-in presets.
	 */
	icon?: AttachmentButtonIcon | ReactNode;
	onClick?: () => void;
}

function isIconName<T>(value: T): value is T & AttachmentButtonIcon {
	return value === "plus" || value === "paperclip";
}

export const AttachmentButton = memo(function AttachmentButton({
	onClick,
	icon = "plus",
}: AttachmentButtonProps) {
	const iconClassName = "w-4 h-4 text-muted-foreground";
	let iconNode: ReactNode;
	if (isIconName(icon)) {
		iconNode =
			icon === "paperclip" ? (
				<HugeiconsIcon
					className={iconClassName}
					icon={Attachment01Icon}
					strokeWidth={2}
				/>
			) : (
				<HugeiconsIcon
					className={iconClassName}
					icon={Add01Icon}
					strokeWidth={2}
				/>
			);
	} else {
		iconNode = icon;
	}

	return (
		<Button
			aria-label="Attach"
			className="size-7"
			onClick={onClick}
			radius="pill"
			size="icon"
			type="button"
			variant="ghost"
		>
			{iconNode}
		</Button>
	);
});
