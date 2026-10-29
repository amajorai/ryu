"use client";
import { usePrefersReducedMotion } from "@ryu/ui/components/reduced-motion.ts";
import {
	isNativeNumber,
	isNativeText,
} from "@ryu/ui/lib/native-primitive-observation.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import type { LenisOptions } from "lenis";
import { ReactLenis, useLenis } from "lenis/react";
import {
	type MotionStyle,
	type MotionValue,
	motion,
	useMotionValue,
	useSpring,
} from "motion/react";
import type { ComponentProps, ReactNode } from "react";
import { useCallback, useEffect, useRef } from "react";
import styles from "./smooth-scroll.module.css";
import {
	driveLenisOnDemand,
	useSmoothInputIntent,
} from "./smooth-scroll-frames.ts";

const DEFAULT_SPRING = {
	damping: 26,
	mass: 0.25,
	stiffness: 150,
};

export interface SmoothScrollProps
	extends Omit<
		ComponentProps<typeof ReactLenis>,
		"autoRaf" | "options" | "root"
	> {
	/** Lenis options to merge with the website defaults. */
	options?: LenisOptions;
	/** Use the document scroll container instead of a local wrapper. */
	root?: boolean;
}

/** Runs Lenis's frame loop only while it animates (see `driveLenisOnDemand`). */
function LenisFrames() {
	const lenis = useLenis();
	useEffect(() => (lenis ? driveLenisOnDemand(lenis) : undefined), [lenis]);
	return null;
}

/**
 * BeUI-style smooth-scroll provider for the public website.
 *
 * Lenis owns the scroll interpolation while this wrapper keeps the reduced
 * motion path native. Consumers can read the same motion values in either
 * case through `useSmoothScroll`.
 *
 * Lenis advances only while a smooth scroll is animating, never every frame of
 * an idle page. In root mode it is also created only once the visitor first
 * uses an input it smooths (the wheel, by default); until then the document
 * scrolls natively and `useLenis` consumers see no instance, exactly as before
 * Lenis loads. Children render outside the Lenis provider in root mode (they
 * read the root store instead), so creating Lenis never remounts them.
 */
export function SmoothScroll({
	children,
	className,
	options,
	root = true,
	...props
}: SmoothScrollProps) {
	const reduce = usePrefersReducedMotion();
	// The frame loop belongs to `LenisFrames`; Lenis's own would run every frame.
	const mergedOptions: LenisOptions = {
		duration: 1.05,
		smoothWheel: true,
		...options,
		autoRaf: false,
	};
	const intent = useSmoothInputIntent(root && !reduce, mergedOptions);

	if (root) {
		return (
			<>
				{children}
				{intent && !reduce ? (
					<ReactLenis
						className={cn("min-h-0", className)}
						options={mergedOptions}
						root
						{...props}
					>
						<LenisFrames />
					</ReactLenis>
				) : null}
			</>
		);
	}

	if (reduce) {
		return <>{children}</>;
	}

	return (
		<ReactLenis
			className={cn("min-h-0", className)}
			options={mergedOptions}
			root={false}
			{...props}
		>
			<LenisFrames />
			{children}
		</ReactLenis>
	);
}

export interface SmoothScrollState {
	isScrolling: ReturnType<typeof useMotionValue<boolean>>;
	progress: ReturnType<typeof useMotionValue<number>>;
	scrollTo: (
		target: string | number | HTMLElement,
		immediate?: boolean
	) => void;
	scrollY: ReturnType<typeof useMotionValue<number>>;
	velocity: ReturnType<typeof useMotionValue<number>>;
}

/** Read the active Lenis scroll state as motion values. */
export function useSmoothScroll(): SmoothScrollState {
	const scrollY = useMotionValue(0);
	const progress = useMotionValue(0);
	const velocity = useMotionValue(0);
	const isScrolling = useMotionValue(false);
	const lenis = useLenis((instance) => {
		scrollY.set(instance.scroll);
		// Lenis reports 0/0 (NaN) on a page that cannot scroll; keep the rail empty.
		progress.set(Number.isFinite(instance.progress) ? instance.progress : 0);
		velocity.set(instance.velocity);
		isScrolling.set(instance.isScrolling !== false);
	});

	const scrollTo = useCallback(
		(target: string | number | HTMLElement, immediate = false) => {
			if (lenis) {
				lenis.scrollTo(target, { immediate });
				return;
			}
			if (isNativeNumber(target)) {
				window.scrollTo({
					behavior: immediate ? "auto" : "smooth",
					top: target,
				});
				return;
			}
			const element = isNativeText(target)
				? document.querySelector<HTMLElement>(target)
				: target;
			element?.scrollIntoView({ behavior: immediate ? "auto" : "smooth" });
		},
		[lenis]
	);

	const fallbackFrame = useRef<number | null>(null);
	useEffect(() => {
		if (lenis || globalThis.window === undefined) {
			return;
		}

		const syncNativeScroll = () => {
			fallbackFrame.current = null;
			const maxScroll =
				document.documentElement.scrollHeight - window.innerHeight;
			const nextScroll = window.scrollY;
			scrollY.set(nextScroll);
			progress.set(maxScroll > 0 ? nextScroll / maxScroll : 0);
			velocity.set(0);
			isScrolling.set(false);
		};
		const onScroll = () => {
			if (fallbackFrame.current !== null) {
				return;
			}
			fallbackFrame.current = window.requestAnimationFrame(syncNativeScroll);
		};
		window.addEventListener("scroll", onScroll, { passive: true });
		syncNativeScroll();
		return () => {
			window.removeEventListener("scroll", onScroll);
			if (fallbackFrame.current !== null) {
				window.cancelAnimationFrame(fallbackFrame.current);
			}
		};
	}, [isScrolling, lenis, progress, scrollY, velocity]);

	return { isScrolling, progress, scrollTo, scrollY, velocity };
}

/** Motion binds the spring-driven progress to the module's CSS variable. */
interface ScrollProgressStyle extends MotionStyle {
	"--blocks-progress": MotionValue<number>;
}

export interface ScrollProgressProps
	extends Omit<ComponentProps<typeof motion.div>, "style"> {
	className?: string;
}

/** A reduced-motion-safe progress rail for the active scroll context. */
export function ScrollProgress({ className, ...props }: ScrollProgressProps) {
	const { progress } = useSmoothScroll();
	const scaleX = useSpring(progress, DEFAULT_SPRING);

	return (
		<motion.div
			aria-hidden="true"
			className={cn(
				"pointer-events-none fixed inset-x-0 top-0 z-50 h-0.5 origin-left bg-foreground/60",
				styles.progress,
				className
			)}
			data-slot="scroll-progress"
			{...props}
			style={
				{
					"--blocks-progress": scaleX,
				} satisfies ScrollProgressStyle as ScrollProgressStyle
			}
		/>
	);
}

export type SmoothScrollChildren = ReactNode;
