import {
	Cancel01Icon,
	FullScreenIcon,
	MinimizeScreenIcon,
	MinusSignIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { ProgressiveBlur } from "@ryu/ui/components/progressive-blur.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import { type MouseEvent as ReactMouseEvent, useState } from "react";
import type { OsWindow } from "./OsDesktopSurface.apps.tsx";

export function OsWindowCard({
	active,
	minimized,
	onActivate,
	onClose,
	onMinimize,
	window,
}: {
	active: boolean;
	minimized: boolean;
	onActivate: () => void;
	onClose: () => void;
	onMinimize: () => void;
	window: OsWindow;
}) {
	const tl = useLiteralMessages();
	const [maximized, setMaximized] = useState(false);
	const isVisible = active && !minimized;
	const frameClassName = maximized
		? "inset-3 bottom-5"
		: "inset-3 bottom-5 sm:top-8 sm:right-[14%] sm:bottom-24 sm:left-[14%]";
	const controlClassName =
		"flex size-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
	const stopAnd = (action: () => void) => (event: ReactMouseEvent) => {
		event.stopPropagation();
		action();
	};

	return (
		<article
			className={cn(
				"absolute flex min-h-0 flex-col overflow-hidden rounded-(--radius-os-window) border border-white/15 bg-background/90 text-foreground shadow-(--shadow-os-window) backdrop-blur-xl",
				frameClassName,
				isVisible ? "z-20 flex" : "z-10 hidden"
			)}
			data-active={active ? "true" : "false"}
			data-maximized={maximized ? "true" : "false"}
			data-minimized={minimized ? "true" : "false"}
			data-testid={`os-window-${window.id}`}
			onMouseDown={onActivate}
		>
			<header className="relative z-10 flex h-10 shrink-0 items-center px-2">
				<ProgressiveBlur blurAmount="16px" height="68px" position="top" />
				<span
					className="pointer-events-none absolute inset-x-20 z-10 truncate text-center font-medium text-muted-foreground text-xs"
					title={window.title}
				>
					{window.title}
				</span>
				<div className="relative z-10 ml-auto flex items-center gap-0.5">
					<button
						aria-label={tl("Minimize {title}", { title: window.title })}
						className={controlClassName}
						data-testid={`os-window-${window.id}-minimize`}
						onClick={stopAnd(onMinimize)}
						type="button"
					>
						<HugeiconsIcon
							aria-hidden="true"
							className="size-3.5"
							icon={MinusSignIcon}
						/>
					</button>
					<button
						aria-label={`${maximized ? "Restore" : "Maximize"} ${window.title}`}
						className={controlClassName}
						data-testid={`os-window-${window.id}-maximize`}
						onClick={stopAnd(() => setMaximized((value) => !value))}
						type="button"
					>
						{maximized ? (
							<HugeiconsIcon
								aria-hidden="true"
								className="size-3.5"
								icon={MinimizeScreenIcon}
							/>
						) : (
							<HugeiconsIcon
								aria-hidden="true"
								className="size-3.5"
								icon={FullScreenIcon}
							/>
						)}
					</button>
					<button
						aria-label={tl("Close {title}", { title: window.title })}
						className={controlClassName}
						data-testid={`os-window-${window.id}-close`}
						onClick={stopAnd(onClose)}
						type="button"
					>
						<HugeiconsIcon
							aria-hidden="true"
							className="size-3.5"
							icon={Cancel01Icon}
						/>
					</button>
				</div>
			</header>
			<div className="min-h-0 flex-1 overflow-hidden">{window.content}</div>
		</article>
	);
}
