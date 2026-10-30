import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import {
	type KeyboardEvent as ReactKeyboardEvent,
	useEffect,
	useRef,
} from "react";
import {
	type HoloAgent,
	type MenuItemPlacement,
	polar,
} from "./hologram-model.ts";
import {
	MENU_ARC,
	MENU_ITEMS,
	MENU_RADIUS,
	MENU_SIZES,
	menuArcPath,
	type RadialAction,
} from "./hologram-orbit-geometry.ts";
import { HUD_LABEL } from "./hologram-parts.tsx";

export function RadialMenu({
	agent,
	nodeId,
	onAction,
	onClose,
	placements,
}: {
	agent: HoloAgent;
	/** The node that opened the menu; focus moving back to it keeps nothing open. */
	nodeId: string;
	onAction: (action: RadialAction) => void;
	/** Closes the menu; `refocus` returns focus to the node. */
	onClose: (refocus: boolean) => void;
	placements: MenuItemPlacement[];
}) {
	const tl = useLiteralMessages();
	const itemsRef = useRef<(HTMLButtonElement | null)[]>([]);
	useEffect(() => {
		itemsRef.current[0]?.focus({ preventScroll: true });
	}, []);
	const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
		const items = itemsRef.current.filter(
			(item): item is HTMLButtonElement => item !== null && !item.disabled
		);
		const index = items.indexOf(document.activeElement as HTMLButtonElement);
		if (event.key === "Escape") {
			event.preventDefault();
			event.stopPropagation();
			onClose(true);
			return;
		}
		let step = 0;
		if (event.key === "ArrowDown" || event.key === "ArrowRight") {
			step = 1;
		} else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
			step = -1;
		}
		if (step !== 0 && items.length > 0) {
			event.preventDefault();
			items[(index + step + items.length) % items.length]?.focus();
		}
	};
	return (
		<div
			aria-label={tl("{name} actions", { name: agent.name })}
			className="absolute top-6 left-6 z-40"
			data-holo-menu={nodeId}
			onBlur={(event) => {
				const next = event.relatedTarget;
				if (next instanceof Node && event.currentTarget.contains(next)) {
					return;
				}
				onClose(false);
			}}
			onKeyDown={onKeyDown}
			role="menu"
		>
			<svg
				aria-hidden="true"
				className="pointer-events-none absolute overflow-visible"
				height={1}
				width={1}
			>
				<path
					className="stroke-(--holo-ink)"
					d={menuArcPath(placements)}
					fill="none"
					strokeWidth={1}
				/>
				{placements.map((place, index) => {
					const from = polar(place.angle, MENU_ARC - 3);
					const to = polar(place.angle, MENU_ARC + 3);
					return (
						<line
							className="stroke-(--holo-ink)"
							key={MENU_ITEMS[index]?.action ?? index}
							strokeWidth={1}
							x1={from.x}
							x2={to.x}
							y1={from.y}
							y2={to.y}
						/>
					);
				})}
			</svg>
			{MENU_ITEMS.map((item, index) => {
				const place = placements[index] ?? {
					angle: 0,
					left: 0,
					reach: MENU_RADIUS,
					top: 0,
				};
				const disabled =
					item.action === "open-latest" && agent.latestThreadId === null;
				return (
					<button
						className={cn(
							HUD_LABEL,
							"absolute flex h-6 items-center justify-center whitespace-nowrap rounded-sm bg-(--holo-deck) px-2 text-(--holo-text) outline-none transition-colors duration-150 hover:bg-(--holo-ink) hover:text-(--holo-deck) focus-visible:bg-(--holo-ink) focus-visible:text-(--holo-deck) active:bg-(--holo-ink)/80 disabled:pointer-events-none disabled:text-(--holo-faint) motion-safe:animate-[holo-pop_140ms_cubic-bezier(0.2,0,0,1)_backwards]"
						)}
						disabled={disabled}
						key={item.action}
						onClick={() => onAction(item.action)}
						ref={(node) => {
							itemsRef.current[index] = node;
						}}
						role="menuitem"
						style={{
							animationDelay: `${index * 30}ms`,
							left: place.left,
							top: place.top,
							width: MENU_SIZES[index]?.width,
						}}
						tabIndex={index === 0 ? 0 : -1}
						type="button"
					>
						{item.label}
					</button>
				);
			})}
		</div>
	);
}
