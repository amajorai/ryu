// Bouncy accordion — ported from beui.dev/components/motion/bouncy-accordion.
// Adapted to this app's conventions: framer-motion (not motion/react), the
// shared `cn`, and a locally-inlined EASE_OUT token.

import { cn } from "@ryu/ui/lib/utils";
import { motion, type Transition, useReducedMotion } from "framer-motion";
import { ChevronDown } from "lucide-react";
import {
	type ReactNode,
	useCallback,
	useId,
	useLayoutEffect,
	useRef,
	useState,
} from "react";

// Strong custom ease — defaults like `ease-out` feel weak for the fade.
const EASE_OUT = [0.16, 1, 0.3, 1] as const;

export interface BouncyAccordionItem {
	description?: ReactNode;
	disabled?: boolean;
	icon?: ReactNode;
	id: string;
	title: ReactNode;
}

export interface BouncyAccordionClassNames {
	chevron?: string;
	content?: string;
	description?: string;
	icon?: string;
	item?: string;
	root?: string;
	title?: string;
	trigger?: string;
}

export interface BouncyAccordionProps {
	className?: string;
	classNames?: BouncyAccordionClassNames;
	collapsible?: boolean;
	defaultValue?: string | null;
	items: BouncyAccordionItem[];
	onValueChange?: (value: string | null) => void;
	value?: string | null;
}

// Local springs keep the accordion's connected groups moving together while
// avoiding scale projection on text-heavy row contents.
// Gap spring: must not overshoot y — positive y overshoot drifts items below
// their resting point and briefly overlaps the next item.
const ROW_TRANSITION: Transition = {
	type: "spring",
	duration: 0.55,
	bounce: 0.38,
};

const CONTENT_OPEN_TRANSITION: Transition = {
	type: "spring",
	duration: 0.58,
	bounce: 0.32,
};

const CONTENT_CLOSE_TRANSITION: Transition = {
	type: "spring",
	duration: 0.46,
	bounce: 0.26,
};

const DESCRIPTION_TRANSITION: Transition = {
	duration: 0.18,
	ease: EASE_OUT,
};

const CHEVRON_TRANSITION: Transition = {
	type: "spring",
	duration: 0.42,
	bounce: 0.28,
};

function useControllableAccordionValue({
	value,
	defaultValue,
	onValueChange,
}: {
	value?: string | null;
	defaultValue?: string | null;
	onValueChange?: (value: string | null) => void;
}) {
	const [internalValue, setInternalValue] = useState(defaultValue ?? null);
	const isControlled = value !== undefined;
	const currentValue = value ?? internalValue;

	const setValue = useCallback(
		(next: string | null) => {
			if (!isControlled) {
				setInternalValue(next);
			}

			onValueChange?.(next);
		},
		[isControlled, onValueChange]
	);

	return [currentValue, setValue] as const;
}

function BouncyAccordionRow({
	item,
	open,
	startsGroup,
	endsGroup,
	separatedFromPrevious,
	contentId,
	triggerId,
	reduce,
	classNames,
	onToggle,
}: {
	item: BouncyAccordionItem;
	open: boolean;
	startsGroup: boolean;
	endsGroup: boolean;
	separatedFromPrevious: boolean;
	contentId: string;
	triggerId: string;
	reduce: boolean | null;
	classNames?: BouncyAccordionClassNames;
	onToggle: () => void;
}) {
	const contentRef = useRef<HTMLDivElement>(null);
	const [contentHeight, setContentHeight] = useState(0);

	useLayoutEffect(() => {
		const node = contentRef.current;
		if (!node) {
			return;
		}

		const updateHeight = () => {
			setContentHeight(node.offsetHeight);
		};

		updateHeight();

		const observer = new ResizeObserver(updateHeight);
		observer.observe(node);

		return () => {
			observer.disconnect();
		};
	}, []);

	const openContentTransition = open
		? CONTENT_OPEN_TRANSITION
		: CONTENT_CLOSE_TRANSITION;
	const contentTransition = reduce ? { duration: 0 } : openContentTransition;

	return (
		<motion.div
			animate={{ marginTop: separatedFromPrevious ? 12 : 0 }}
			initial={false}
			transition={reduce ? { duration: 0 } : ROW_TRANSITION}
		>
			<motion.div
				animate={{
					borderTopLeftRadius: startsGroup ? 28 : 0,
					borderTopRightRadius: startsGroup ? 28 : 0,
					borderBottomLeftRadius: endsGroup ? 28 : 0,
					borderBottomRightRadius: endsGroup ? 28 : 0,
				}}
				className={cn(
					"overflow-hidden bg-card text-card-foreground",
					item.disabled && "opacity-50",
					classNames?.item
				)}
				data-state={open ? "open" : "closed"}
				initial={false}
				transition={reduce ? { duration: 0 } : ROW_TRANSITION}
			>
				<button
					aria-controls={contentId}
					aria-expanded={open}
					className={cn(
						"flex min-h-[40px] w-full items-center gap-3 px-3 py-2 text-left outline-none transition-colors",
						"focus-visible:bg-muted/25",
						"disabled:pointer-events-none",
						classNames?.trigger
					)}
					disabled={item.disabled}
					id={triggerId}
					onClick={onToggle}
					type="button"
				>
					{item.icon ? (
						<span
							className={cn(
								"grid h-7 w-7 shrink-0 place-items-center text-muted-foreground",
								classNames?.icon
							)}
						>
							{item.icon}
						</span>
					) : null}
					<span
						className={cn(
							"min-w-0 flex-1 truncate text-foreground text-sm",
							classNames?.title
						)}
					>
						{item.title}
					</span>
					<motion.span
						animate={{ rotate: open ? 180 : 0 }}
						aria-hidden
						className={cn(
							"grid h-6 w-6 shrink-0 place-items-center text-muted-foreground",
							classNames?.chevron
						)}
						transition={reduce ? { duration: 0 } : CHEVRON_TRANSITION}
					>
						<ChevronDown className="h-4 w-4" />
					</motion.span>
				</button>

				<motion.div
					animate={{
						height: open && item.description ? contentHeight : 0,
					}}
					aria-hidden={!open}
					aria-labelledby={triggerId}
					className={cn("overflow-hidden", classNames?.content)}
					id={contentId}
					initial={false}
					role="region"
					transition={contentTransition}
				>
					<motion.div
						animate={{
							opacity: open ? 1 : 0,
						}}
						className="px-3 pb-3"
						ref={contentRef}
						transition={reduce ? { duration: 0 } : DESCRIPTION_TRANSITION}
					>
						<div
							className={cn(
								"text-[15px] text-muted-foreground leading-6",
								classNames?.description
							)}
						>
							{item.description}
						</div>
					</motion.div>
				</motion.div>
			</motion.div>
		</motion.div>
	);
}

export function BouncyAccordion({
	items,
	value,
	defaultValue = null,
	onValueChange,
	collapsible = true,
	className,
	classNames,
}: BouncyAccordionProps) {
	const reduce = useReducedMotion();
	const baseId = useId();
	const [activeValue, setActiveValue] = useControllableAccordionValue({
		value,
		defaultValue,
		onValueChange,
	});
	const activeIndex = items.findIndex((item) => item.id === activeValue);

	const toggleItem = useCallback(
		(id: string) => {
			if (activeValue === id) {
				if (collapsible) {
					setActiveValue(null);
				}
				return;
			}

			setActiveValue(id);
		},
		[activeValue, collapsible, setActiveValue]
	);

	return (
		<div className={cn("w-full", className, classNames?.root)}>
			{items.map((item, index) => {
				const open = activeValue === item.id;
				const previousIsOpen = activeIndex === index - 1;
				const nextIsOpen = activeIndex === index + 1;
				const startsGroup = open || index === 0 || previousIsOpen;
				const endsGroup = open || index === items.length - 1 || nextIsOpen;
				const separatedFromPrevious = index > 0 && (open || previousIsOpen);
				const contentId = `${baseId}-${item.id}-content`;
				const triggerId = `${baseId}-${item.id}-trigger`;

				return (
					<BouncyAccordionRow
						classNames={classNames}
						contentId={contentId}
						endsGroup={endsGroup}
						item={item}
						key={item.id}
						onToggle={() => toggleItem(item.id)}
						open={open}
						reduce={reduce}
						separatedFromPrevious={separatedFromPrevious}
						startsGroup={startsGroup}
						triggerId={triggerId}
					/>
				);
			})}
		</div>
	);
}
