"use client";

import { useLocalizedString } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils.ts";
import {
	AnimatePresence,
	type MotionValue,
	motion,
	type SpringOptions,
	useMotionValue,
	useSpring,
	useTransform,
} from "motion/react";
import {
	Children,
	cloneElement,
	createContext,
	isValidElement,
	type ReactElement,
	type ReactNode,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";

const DOCK_HEIGHT = 128;
const DEFAULT_MAGNIFICATION = 80;
const DEFAULT_DISTANCE = 150;
const DEFAULT_PANEL_HEIGHT = 64;
const DEFAULT_ITEM_SIZE = 40;

export interface DockProps {
	children: ReactNode;
	className?: string;
	distance?: number;
	magnification?: number;
	panelHeight?: number;
	spring?: SpringOptions;
}

export interface DockItemProps {
	"aria-label"?: string;
	children: ReactNode;
	className?: string;
	"data-open"?: "false" | "true";
	"data-testid"?: string;
	onClick?: () => void;
	title?: string;
}

export interface DockLabelProps {
	children: ReactNode;
	className?: string;
	isHovered?: MotionValue<number>;
}

export interface DockIconProps {
	children: ReactNode;
	className?: string;
	width?: MotionValue<number>;
}

interface DockContextValue {
	distance: number;
	magnification: number;
	mouseX: MotionValue<number>;
	spring: SpringOptions;
}

interface DockChildProps {
	isHovered?: MotionValue<number>;
	width?: MotionValue<number>;
}

const DockContext = createContext<DockContextValue | undefined>(undefined);

function useDock(): DockContextValue {
	const context = useContext(DockContext);
	if (!context) {
		throw new Error("useDock must be used within a Dock provider");
	}
	return context;
}

/**
 * Motion Primitives' magnified dock, kept in the shared UI package so the OS
 * surface and future desktop surfaces use one interaction primitive.
 */
export function Dock({
	children,
	className,
	distance = DEFAULT_DISTANCE,
	magnification = DEFAULT_MAGNIFICATION,
	panelHeight = DEFAULT_PANEL_HEIGHT,
	spring = { damping: 12, mass: 0.1, stiffness: 150 },
}: DockProps) {
	const localizedDockLabel = useLocalizedString("Application dock");
	const mouseX = useMotionValue(Number.POSITIVE_INFINITY);
	const isHovered = useMotionValue(0);
	const maxHeight = useMemo(
		() => Math.max(DOCK_HEIGHT, magnification + magnification / 2 + 4),
		[magnification]
	);
	const heightRow = useTransform(isHovered, [0, 1], [panelHeight, maxHeight]);
	const height = useSpring(heightRow, spring);

	return (
		<motion.div
			className="mx-2 flex max-w-full items-end overflow-x-auto"
			style={{ height, scrollbarWidth: "none" }}
		>
			<motion.div
				aria-label={localizedDockLabel}
				className={cn(
					"mx-auto flex w-fit gap-2 rounded-2xl border border-white/15 bg-black/25 px-3 shadow-2xl backdrop-blur-2xl",
					className
				)}
				onMouseLeave={() => {
					isHovered.set(0);
					mouseX.set(Number.POSITIVE_INFINITY);
				}}
				onMouseMove={({ pageX }) => {
					isHovered.set(1);
					mouseX.set(pageX);
				}}
				role="toolbar"
				style={{ height: panelHeight }}
			>
				<DockContext.Provider
					value={{ distance, magnification, mouseX, spring }}
				>
					{children}
				</DockContext.Provider>
			</motion.div>
		</motion.div>
	);
}

export function DockItem({
	"aria-label": ariaLabel,
	children,
	className,
	"data-open": dataOpen,
	"data-testid": dataTestId,
	onClick,
	title,
}: DockItemProps) {
	const localizedAriaLabel = useLocalizedString(ariaLabel);
	const localizedTitle = useLocalizedString(title);
	const ref = useRef<HTMLDivElement>(null);
	const { distance, magnification, mouseX, spring } = useDock();
	const isHovered = useMotionValue(0);
	const mouseDistance = useTransform(mouseX, (value) => {
		const bounds = ref.current?.getBoundingClientRect() ?? { width: 0, x: 0 };
		return value - bounds.x - bounds.width / 2;
	});
	const widthTransform = useTransform(
		mouseDistance,
		[-distance, 0, distance],
		[DEFAULT_ITEM_SIZE, magnification, DEFAULT_ITEM_SIZE]
	);
	const width = useSpring(widthTransform, spring);

	return (
		<motion.div
			aria-label={localizedAriaLabel}
			className={cn(
				"relative inline-flex aspect-square shrink-0 items-center justify-center rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-white/80",
				className
			)}
			data-open={dataOpen}
			data-testid={dataTestId}
			onBlur={() => isHovered.set(0)}
			onClick={onClick}
			onFocus={() => isHovered.set(1)}
			onHoverEnd={() => isHovered.set(0)}
			onHoverStart={() => isHovered.set(1)}
			onKeyDown={(event) => {
				if (onClick && (event.key === "Enter" || event.key === " ")) {
					event.preventDefault();
					onClick();
				}
			}}
			ref={ref}
			role="button"
			style={{ width }}
			tabIndex={0}
			title={localizedTitle}
		>
			{Children.map(children, (child) => {
				if (!isValidElement<DockChildProps>(child)) {
					return child;
				}
				if (child.type === DockLabel) {
					return cloneElement(child as ReactElement<DockLabelProps>, {
						isHovered,
					});
				}
				if (child.type === DockIcon) {
					return cloneElement(child as ReactElement<DockIconProps>, {
						width,
					});
				}
				return child;
			})}
		</motion.div>
	);
}

export function DockLabel({ children, className, isHovered }: DockLabelProps) {
	const fallbackHovered = useMotionValue(0);
	const hovered = isHovered ?? fallbackHovered;
	const [isVisible, setIsVisible] = useState(false);

	useEffect(() => {
		return hovered.on("change", (latest) => setIsVisible(latest === 1));
	}, [hovered]);

	return (
		<AnimatePresence>
			{isVisible ? (
				<motion.div
					animate={{ opacity: 1, y: -10 }}
					className={cn(
						"absolute -top-6 left-1/2 w-fit -translate-x-1/2 whitespace-pre rounded-lg border border-white/15 bg-black/65 px-2 py-1 font-medium text-[11px] text-white shadow-xl backdrop-blur-xl",
						className
					)}
					exit={{ opacity: 0, y: 0 }}
					initial={{ opacity: 0, y: 0 }}
					role="tooltip"
				>
					{children}
				</motion.div>
			) : null}
		</AnimatePresence>
	);
}

export function DockIcon({ children, className, width }: DockIconProps) {
	const fallbackWidth = useMotionValue(DEFAULT_ITEM_SIZE);
	const itemWidth = width ?? fallbackWidth;
	const iconWidth = useTransform(itemWidth, (value) => value / 2);

	return (
		<motion.div
			className={cn("flex items-center justify-center", className)}
			style={{ height: iconWidth, width: iconWidth }}
		>
			{children}
		</motion.div>
	);
}
