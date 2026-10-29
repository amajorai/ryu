"use client";

import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils.ts";
import {
	ArrowLeftIcon,
	ChevronRightIcon,
	MoreHorizontalIcon,
	XIcon,
} from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { type KeyboardEvent, type ReactNode, useId, useState } from "react";

const RAIL_TRANSITION = {
	damping: 21,
	mass: 0.8,
	stiffness: 240,
	type: "spring" as const,
};

const LAYER_VARIANTS = {
	enter: { opacity: 0, x: 12 },
	exit: { opacity: 0, x: -12 },
	present: { opacity: 1, x: 0 },
};

export interface NestedOverflowToolbarCategory {
	content: ReactNode;
	icon?: ReactNode;
	id: string;
	label: string;
}

export interface NestedOverflowToolbarProps {
	ariaLabel?: string;
	categories: NestedOverflowToolbarCategory[];
	className?: string;
	defaultOpen?: boolean;
	/** Present expanded categories as a grid instead of nested menus. */
	expandedLayout?: "nested" | "grid";
	placement?: "fixed" | "inline";
	primary?: ReactNode;
}

/**
 * A compact, bottom-fixed action rail with nested menus or an expanded grid.
 *
 * In grid mode, all categories are visible together above the compact rail.
 *
 * The root keeps primary actions visible and reveals category buttons behind the
 * overflow toggle. Selecting a category replaces the rail contents with that
 * category and keeps a back button first, so large tool collections stay easy to
 * scan without turning the editor into a permanent wall of controls.
 */
export function NestedOverflowToolbar({
	ariaLabel = "Editor tools",
	categories,
	className,
	defaultOpen = false,
	expandedLayout = "nested",
	primary,
	placement = "fixed",
}: NestedOverflowToolbarProps) {
	const reduce = useReducedMotion();
	const tl = useLiteralMessages();
	const controlsId = useId();
	const [isOpen, setIsOpen] = useState(defaultOpen);
	const [activeCategoryId, setActiveCategoryId] = useState<string | null>(null);
	const activeCategory =
		expandedLayout === "nested"
			? categories.find((category) => category.id === activeCategoryId)
			: undefined;
	const visibleLayerId =
		expandedLayout === "grid"
			? `${controlsId}-expanded-grid`
			: activeCategory
				? `${controlsId}-category-${activeCategory.id}`
				: `${controlsId}-${isOpen ? "open" : "closed"}`;
	const rootLayerId =
		expandedLayout === "grid" ? `${controlsId}-root` : visibleLayerId;
	const transition = reduce ? { duration: 0 } : RAIL_TRANSITION;

	const close = () => {
		setIsOpen(false);
		setActiveCategoryId(null);
	};

	const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (event.key !== "Escape") {
			return;
		}
		event.preventDefault();
		if (activeCategory) {
			setActiveCategoryId(null);
			return;
		}
		if (isOpen) {
			close();
		}
	};

	return (
		<div
			className={cn(
				placement === "inline"
					? "pointer-events-auto relative z-10 flex justify-start"
					: "pointer-events-none fixed inset-x-2 bottom-4 z-[60] flex justify-center sm:inset-x-4 sm:bottom-6",
				className
			)}
			onKeyDown={handleKeyDown}
		>
			<AnimatePresence initial={false}>
				{expandedLayout === "grid" && isOpen ? (
					<motion.div
						animate={{ opacity: 1, y: 0 }}
						aria-hidden={!isOpen}
						aria-label={tl("{ariaLabel} expanded", { ariaLabel })}
						className="pointer-events-auto absolute bottom-full mb-2 grid max-h-[min(60vh,30rem)] w-[min(72rem,calc(100vw-2rem))] grid-cols-2 gap-2 overflow-y-auto rounded-2xl border border-border bg-card/95 p-2 text-card-foreground shadow-2xl shadow-black/10 backdrop-blur-xl sm:grid-cols-3 lg:grid-cols-4 dark:shadow-black/30"
						exit={reduce ? { opacity: 0 } : { opacity: 0, y: 4 }}
						id={visibleLayerId}
						initial={reduce ? { opacity: 0 } : { opacity: 0, y: 6 }}
						key="expanded-grid"
						role="group"
						transition={transition}
					>
						{categories.map((category) => (
							<div
								aria-label={tl("{label} tools", { label: category.label })}
								className="min-w-0 rounded-xl border border-border/60 bg-background/70 p-2"
								key={category.id}
								role="group"
							>
								<div className="mb-1.5 flex items-center gap-1.5 border-border/60 border-b px-1 pb-1.5 font-medium text-muted-foreground text-xs">
									<span className="inline-flex size-4 shrink-0 items-center justify-center [&_svg]:size-3.5">
										{category.icon}
									</span>
									{category.label}
								</div>
								<div className="min-w-0 max-w-full">{category.content}</div>
							</div>
						))}
					</motion.div>
				) : null}
			</AnimatePresence>

			<motion.div
				aria-label={ariaLabel}
				className="pointer-events-auto inline-flex max-w-full items-center overflow-hidden rounded-full border border-border bg-card/95 p-1 shadow-2xl shadow-black/10 backdrop-blur-xl supports-[backdrop-filter]:bg-card/80 dark:shadow-black/30"
				data-slot="nested-overflow-toolbar"
				layout
				role="toolbar"
				transition={transition}
			>
				<AnimatePresence initial={false} mode="popLayout">
					{activeCategory ? (
						<motion.div
							animate="present"
							className="flex min-w-0 max-w-[calc(100vw-4rem)] items-center gap-1"
							exit="exit"
							id={visibleLayerId}
							initial="enter"
							key={activeCategory.id}
							transition={transition}
							variants={LAYER_VARIANTS}
						>
							<RailButton
								ariaLabel="Back to editor tools"
								onClick={() => setActiveCategoryId(null)}
							>
								<ArrowLeftIcon />
								<span className="sr-only">Back</span>
							</RailButton>
							<span className="hidden shrink-0 px-1 text-muted-foreground text-xs sm:inline">
								{activeCategory.label}
							</span>
							<div className="flex min-w-0 items-center gap-1 overflow-x-auto">
								{activeCategory.content}
							</div>
						</motion.div>
					) : (
						<motion.div
							animate="present"
							className="flex min-w-0 items-center gap-1"
							exit="exit"
							id={rootLayerId}
							initial="enter"
							key={isOpen ? "open" : "closed"}
							transition={transition}
							variants={LAYER_VARIANTS}
						>
							{primary ? (
								<div className="flex shrink-0 items-center gap-1">
									{primary}
								</div>
							) : null}
							{isOpen && expandedLayout === "nested" ? (
								<div className="flex min-w-0 max-w-[calc(100vw-5rem)] items-center gap-1 overflow-x-auto">
									{categories.map((category) => (
										<RailButton
											ariaLabel={tl("Open {label} tools", {
												label: category.label,
											})}
											key={category.id}
											onClick={() => {
												setIsOpen(true);
												setActiveCategoryId(category.id);
											}}
										>
											{category.icon}
											<span>{category.label}</span>
											<ChevronRightIcon className="size-3 text-muted-foreground" />
										</RailButton>
									))}
								</div>
							) : null}
						</motion.div>
					)}
				</AnimatePresence>

				<motion.button
					aria-controls={isOpen ? visibleLayerId : undefined}
					aria-expanded={isOpen}
					aria-label={isOpen ? "Close editor tools" : "Open editor tools"}
					className={cn(
						"relative inline-grid size-9 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground outline-none transition-transform",
						"focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
						"hover:scale-[1.03] active:scale-95"
					)}
					onClick={() => {
						if (isOpen) {
							close();
							return;
						}
						setIsOpen(true);
					}}
					title={isOpen ? "Close editor tools" : "Open editor tools"}
					type="button"
				>
					{isOpen ? (
						<XIcon className="size-4" />
					) : (
						<MoreHorizontalIcon className="size-4" />
					)}
				</motion.button>
			</motion.div>
		</div>
	);
}

function RailButton({
	ariaLabel,
	children,
	onClick,
}: {
	ariaLabel: string;
	children: ReactNode;
	onClick: () => void;
}) {
	return (
		<button
			aria-label={ariaLabel}
			className={cn(
				"inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-full bg-background px-3 font-medium text-foreground text-xs outline-none transition-colors",
				"hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
				"[&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0"
			)}
			onClick={onClick}
			type="button"
		>
			{children}
		</button>
	);
}
