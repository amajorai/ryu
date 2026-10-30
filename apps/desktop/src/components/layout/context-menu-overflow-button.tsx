import { MoreHorizontalIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils.ts";
import type { RefObject } from "react";
import layoutStyles from "./context-menu-overflow-button.module.css";

/** Open the Base UI context menu already attached to a row. Keeping this as a
 * native context-menu event means the hover ellipsis and right-click can never
 * drift into two different sets of actions. */
export function openContextMenuAt(target: HTMLElement | null) {
	if (!target) {
		return;
	}
	const rect = target.getBoundingClientRect();
	target.dispatchEvent(
		new MouseEvent("contextmenu", {
			bubbles: true,
			button: 2,
			cancelable: true,
			clientX: rect.right,
			clientY: rect.top + rect.height / 2,
			buttons: 2,
		})
	);
}

/** A quiet, keyboard-reachable ellipsis that shares its row's context menu. */
export function ContextMenuOverflowButton({
	className,
	label,
	targetRef,
}: {
	className?: string;
	label: string;
	targetRef: RefObject<HTMLElement | null>;
}) {
	const tl = useLiteralMessages();
	return (
		<button
			aria-label={tl("{label} options", { label })}
			className={cn(
				cn(
					"flex size-5 shrink-0 items-center justify-center rounded-lg text-muted-foreground opacity-0 hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover/hdr:opacity-100 group-hover/row:opacity-100 group-hover/subsection:opacity-100 group-hover/tab:opacity-100",
					layoutStyles.authored1
				),
				className
			)}
			onClick={(event) => {
				event.stopPropagation();
				openContextMenuAt(targetRef.current);
			}}
			type="button"
		>
			<HugeiconsIcon icon={MoreHorizontalIcon} size={14} />
		</button>
	);
}
