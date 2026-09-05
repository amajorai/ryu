"use client";

import { useHoverCapable } from "@ryu/ui/hooks/use-hover-capable";
import { SPRING_LAYOUT, SPRING_PRESS } from "@ryu/ui/lib/ease";
import { cn } from "@ryu/ui/lib/utils";
import {
	AnimatePresence,
	LayoutGroup,
	motion,
	useReducedMotion,
} from "motion/react";
import type { ReactNode } from "react";
import {
	useCallback,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";
import { createPortal } from "react-dom";

const MAX_PREVIEWS = 5;

export interface ProjectFolderPreview {
	className?: string;
	content: ReactNode | ((expanded: boolean) => ReactNode);
	id: string;
	label?: string;
	onClick?: () => void;
}

export interface ProjectFolderTransform {
	opacity: number;
	rotate: number;
	scale: number;
	x: number;
	y: number;
	zIndex: number;
}

export interface ProjectFolderProps {
	ariaLabel?: string;
	className?: string;
	count?: number;
	defaultExpanded?: boolean;
	defaultOpen?: boolean;
	description?: string;
	disabled?: boolean;
	emptyContent?: ReactNode | ((closeBeforeNavigation: () => void) => ReactNode);
	expanded?: boolean;
	itemLabel?: string;
	onClick?: () => void;
	onExpandedChange?: (expanded: boolean) => void;
	onOpenChange?: (open: boolean) => void;
	open?: boolean;
	previews: ProjectFolderPreview[];
	title: string;
}

export function getProjectFolderPreviewTransform(
	index: number,
	count: number
): ProjectFolderTransform {
	const center = Math.max(0, count - 1) / 2;
	const distance = index - center;

	return {
		x: distance * 18,
		y: Math.abs(distance) * 7,
		rotate: distance * 5,
		scale: 1 - Math.abs(distance) * 0.04,
		opacity: 1 - Math.abs(distance) * 0.04,
		zIndex: Math.max(1, count - index),
	};
}

function useControllableState(
	value: boolean | undefined,
	defaultValue: boolean,
	onChange: ((value: boolean) => void) | undefined
) {
	const [uncontrolledValue, setUncontrolledValue] = useState(defaultValue);
	const controlled = value !== undefined;
	const currentValue = controlled ? value : uncontrolledValue;
	const setValue = useCallback(
		(nextValue: boolean) => {
			if (!controlled) {
				setUncontrolledValue(nextValue);
			}
			onChange?.(nextValue);
		},
		[controlled, onChange]
	);

	return [currentValue, setValue] as const;
}

function renderPreviewContent(
	preview: ProjectFolderPreview,
	expanded: boolean
) {
	return typeof preview.content === "function"
		? preview.content(expanded)
		: preview.content;
}

export function ProjectFolder({
	title,
	description,
	previews,
	count = previews.length,
	itemLabel = "item",
	emptyContent,
	open: openProp,
	defaultOpen = false,
	expanded: expandedProp,
	defaultExpanded = false,
	onOpenChange,
	onExpandedChange,
	disabled = false,
	ariaLabel,
	onClick,
	className,
}: ProjectFolderProps) {
	const [open, setOpen] = useControllableState(
		openProp,
		defaultOpen,
		onOpenChange
	);
	const [expanded, setExpanded] = useControllableState(
		expandedProp,
		defaultExpanded,
		onExpandedChange
	);
	const [focused, setFocused] = useState(false);
	const folderRef = useRef<HTMLButtonElement>(null);
	const closeRef = useRef<HTMLButtonElement>(null);
	const dialogRef = useRef<HTMLDivElement>(null);
	const restoreFocusOnExitRef = useRef(true);
	const canHover = useHoverCapable();
	const reduceMotion = useReducedMotion();
	const dialogId = useId();
	const cappedPreviews = useMemo(
		() => previews.slice(0, MAX_PREVIEWS),
		[previews]
	);
	const itemText = `${count} ${itemLabel}${count === 1 ? "" : "s"}`;
	const transition = reduceMotion ? { duration: 0 } : SPRING_LAYOUT;

	const close = useCallback(() => {
		restoreFocusOnExitRef.current = true;
		setExpanded(false);
		setOpen(false);
	}, [setExpanded, setOpen]);
	const closeBeforeNavigation = useCallback(() => {
		restoreFocusOnExitRef.current = false;
		setExpanded(false);
		setOpen(false);
	}, [setExpanded, setOpen]);

	useEffect(() => {
		if (!expanded || typeof document === "undefined") {
			return;
		}

		const previousOverflow = document.body.style.overflow;
		document.body.style.overflow = "hidden";
		const focusTimer = window.setTimeout(() => closeRef.current?.focus(), 0);

		return () => {
			window.clearTimeout(focusTimer);
			document.body.style.overflow = previousOverflow;
		};
	}, [expanded]);

	useEffect(() => {
		if (!expanded) {
			return;
		}

		const handleKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				event.preventDefault();
				close();
				return;
			}
			if (event.key !== "Tab" || !dialogRef.current) {
				return;
			}

			const focusable = dialogRef.current.querySelectorAll<HTMLElement>(
				'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
			);
			if (focusable.length === 0) {
				event.preventDefault();
				return;
			}
			const first = focusable.item(0);
			const last = focusable.item(focusable.length - 1);
			if (!(first && last)) {
				return;
			}
			if (event.shiftKey && document.activeElement === first) {
				event.preventDefault();
				last.focus();
			} else if (!event.shiftKey && document.activeElement === last) {
				event.preventDefault();
				first.focus();
			}
		};

		document.addEventListener("keydown", handleKeyDown);
		return () => document.removeEventListener("keydown", handleKeyDown);
	}, [close, expanded]);

	const handlePointerEnter = () => {
		if (canHover && !disabled && !expanded) {
			setOpen(true);
		}
	};
	const handlePointerLeave = () => {
		if (canHover && !focused && !expanded) {
			setOpen(false);
		}
	};
	const handleFocus = () => {
		setFocused(true);
		if (canHover && !disabled && !expanded) {
			setOpen(true);
		}
	};
	const handleBlur = () => {
		setFocused(false);
		if (canHover && !expanded) {
			setOpen(false);
		}
	};
	const handleClick = () => {
		if (disabled) {
			return;
		}
		onClick?.();
		setOpen(true);
		setExpanded(true);
	};

	const folderContent = (
		<div className="relative flex min-h-28 min-w-48 flex-col justify-between p-4 text-left">
			<div>
				<p className="font-medium text-sm">{title}</p>
				{description ? (
					<p className="mt-1 text-muted-foreground text-xs">{description}</p>
				) : null}
			</div>
			<p className="text-muted-foreground text-xs">{itemText}</p>
		</div>
	);

	const overlay =
		typeof document === "undefined"
			? null
			: createPortal(
					<AnimatePresence
						onExitComplete={() => {
							if (restoreFocusOnExitRef.current) {
								folderRef.current?.focus();
							}
							restoreFocusOnExitRef.current = true;
						}}
					>
						{expanded ? (
							<motion.div
								animate={{ opacity: 1 }}
								className="fixed inset-0 z-50 overflow-y-auto bg-background/80 p-6 backdrop-blur-sm"
								exit={{ opacity: 0 }}
								initial={{ opacity: 0 }}
								onMouseDown={(event) => {
									if (event.target === event.currentTarget) {
										close();
									}
								}}
								transition={reduceMotion ? { duration: 0 } : SPRING_PRESS}
							>
								<motion.div
									animate={{ scale: 1, y: 0 }}
									aria-describedby={
										description ? `${dialogId}-description` : undefined
									}
									aria-labelledby={`${dialogId}-title`}
									aria-modal="true"
									className="mx-auto mt-[10vh] max-w-3xl rounded-3xl border bg-card p-6 text-card-foreground shadow-xl"
									exit={{ scale: 0.96, y: 12 }}
									initial={{ scale: 0.96, y: 12 }}
									ref={dialogRef}
									role="dialog"
									transition={transition}
								>
									<div className="flex items-start justify-between gap-4">
										<div>
											<h2
												className="font-medium text-lg"
												id={`${dialogId}-title`}
											>
												{title}
											</h2>
											{description ? (
												<p
													className="mt-1 text-muted-foreground text-sm"
													id={`${dialogId}-description`}
												>
													{description}
												</p>
											) : null}
										</div>
										<button
											aria-label="Close folder"
											className="rounded-full p-2 text-muted-foreground hover:bg-muted hover:text-foreground"
											onClick={close}
											ref={closeRef}
											type="button"
										>
											<span aria-hidden="true">×</span>
										</button>
									</div>
									<div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
										{cappedPreviews.map((preview) => (
											<motion.div
												className={cn(
													"relative overflow-hidden rounded-2xl",
													preview.className
												)}
												key={preview.id}
												layoutId={`project-folder-preview-${preview.id}`}
												transition={transition}
											>
												<div
													aria-hidden={preview.onClick ? true : undefined}
													className={
														preview.onClick ? "pointer-events-none" : undefined
													}
													inert={preview.onClick ? true : undefined}
												>
													{renderPreviewContent(preview, true)}
												</div>
												{preview.onClick ? (
													<button
														aria-label={preview.label}
														className="absolute inset-0 rounded-2xl text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
														onClick={() => {
															closeBeforeNavigation();
															preview.onClick?.();
														}}
														type="button"
													>
														<span className="sr-only">
															{preview.label ?? "Open preview"}
														</span>
													</button>
												) : null}
											</motion.div>
										))}
										{cappedPreviews.length === 0
											? typeof emptyContent === "function"
												? emptyContent(closeBeforeNavigation)
												: emptyContent
											: null}
									</div>
								</motion.div>
							</motion.div>
						) : null}
					</AnimatePresence>,
					document.body
				);

	return (
		<LayoutGroup id={dialogId}>
			<div className="relative">
				<button
					aria-expanded={expanded}
					aria-haspopup="dialog"
					aria-label={ariaLabel ?? title}
					className={cn(
						"block rounded-3xl border bg-card text-card-foreground shadow-sm transition-shadow hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50",
						className
					)}
					disabled={disabled}
					onBlur={handleBlur}
					onClick={handleClick}
					onFocus={handleFocus}
					onPointerEnter={handlePointerEnter}
					onPointerLeave={handlePointerLeave}
					ref={folderRef}
					type="button"
				>
					{folderContent}
				</button>
				<AnimatePresence initial={false}>
					{open && !expanded ? (
						<motion.div
							aria-hidden="true"
							className="pointer-events-none absolute inset-x-3 top-3 bottom-3"
							initial={false}
							transition={transition}
						>
							{cappedPreviews.map((preview, index) => {
								const transform = getProjectFolderPreviewTransform(
									index,
									cappedPreviews.length
								);
								const { zIndex, ...motionTransform } = transform;
								return (
									<motion.div
										animate={motionTransform}
										className={cn(
											"absolute inset-0 overflow-hidden rounded-2xl border bg-muted",
											preview.className
										)}
										inert
										initial={
											reduceMotion
												? motionTransform
												: { ...motionTransform, opacity: 0 }
										}
										key={preview.id}
										layoutId={`project-folder-preview-${preview.id}`}
										style={{ zIndex: transform.zIndex }}
										transition={transition}
									>
										{renderPreviewContent(preview, false)}
									</motion.div>
								);
							})}
						</motion.div>
					) : null}
				</AnimatePresence>
			</div>
			{overlay}
		</LayoutGroup>
	);
}
