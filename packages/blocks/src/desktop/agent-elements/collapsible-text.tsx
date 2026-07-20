import { Button } from "@ryu/ui/components/button";
import { cn } from "@ryu/ui/lib/utils";
import {
	type MouseEvent,
	memo,
	type ReactNode,
	useEffect,
	useRef,
	useState,
} from "react";

export interface CollapsibleTextProps {
	children: ReactNode;
	className?: string;
	/** Applied while collapsed, e.g. `max-h-10` or `max-h-[120px]`. */
	collapsedMaxHeightClass: string;
	collapseLabel?: string;
	contentClassName?: string;
	expandLabel?: string;
	/** Tailwind gradient stop class matching the surface behind the fade. */
	fadeToClass?: string;
	/** Fires when the content area is clicked (not the expand control). */
	onContentClick?: () => void;
}

export const CollapsibleText = memo(function CollapsibleText({
	children,
	className,
	contentClassName,
	collapsedMaxHeightClass,
	fadeToClass = "to-muted",
	expandLabel = "Show more",
	collapseLabel = "Show less",
	onContentClick,
}: CollapsibleTextProps) {
	const [expanded, setExpanded] = useState(false);
	const [canCollapse, setCanCollapse] = useState(false);
	const contentRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const el = contentRef.current;
		if (!el) {
			return;
		}

		const measure = () => {
			if (expanded) {
				return;
			}
			setCanCollapse(el.scrollHeight > el.clientHeight + 1);
		};

		measure();
		const ro = new ResizeObserver(measure);
		ro.observe(el);
		return () => ro.disconnect();
	}, [children, expanded, collapsedMaxHeightClass]);

	const handleContentClick = (event: MouseEvent<HTMLDivElement>) => {
		if (!onContentClick) {
			return;
		}
		if ((event.target as Element).closest("[data-collapsible-expand]")) {
			return;
		}
		onContentClick();
	};

	const showControls = canCollapse || expanded;

	return (
		<div className={cn("relative", className)}>
			<div
				className={cn(
					contentClassName,
					!expanded && collapsedMaxHeightClass,
					!expanded && "overflow-hidden",
					onContentClick && "cursor-pointer"
				)}
				onClick={onContentClick ? handleContentClick : undefined}
				onKeyDown={
					onContentClick
						? (event) => {
								if (event.key === "Enter" || event.key === " ") {
									event.preventDefault();
									onContentClick();
								}
							}
						: undefined
				}
				ref={contentRef}
				role={onContentClick ? "button" : undefined}
				tabIndex={onContentClick ? 0 : undefined}
			>
				{children}
			</div>
			{showControls ? (
				expanded ? (
					<div className="mt-1 flex justify-center">
						<Button
							className="h-6 px-2 text-muted-foreground text-xs hover:text-foreground"
							data-collapsible-expand
							onClick={() => setExpanded(false)}
							size="sm"
							type="button"
							variant="ghost"
						>
							{collapseLabel}
						</Button>
					</div>
				) : (
					<div className="pointer-events-none absolute inset-x-0 bottom-0 h-12">
						<div
							className={cn(
								"absolute inset-0 bg-linear-to-b from-transparent to-50%",
								fadeToClass
							)}
						/>
						<div className="pointer-events-auto relative flex h-full items-end justify-center pb-0.5">
							<Button
								className="h-6 px-2 text-muted-foreground text-xs hover:text-foreground"
								data-collapsible-expand
								onClick={(event) => {
									event.stopPropagation();
									setExpanded(true);
								}}
								size="sm"
								type="button"
								variant="ghost"
							>
								{expandLabel}
							</Button>
						</div>
					</div>
				)
			) : null}
		</div>
	);
});
