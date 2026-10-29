"use client";

import { EASE_OUT } from "@ryu/ui/lib/ease.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import { useReducedMotion } from "motion/react";
import {
	createContext,
	forwardRef,
	type HTMLAttributes,
	type ReactNode,
	type Ref,
	useCallback,
	useContext,
	useId,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";

interface LiquidContextValue {
	getPortal: () => SVGGElement | null;
	getRoot: () => HTMLDivElement | null;
}

const LiquidContext = createContext<LiquidContextValue | null>(null);

function useLiquidContext() {
	const context = useContext(LiquidContext);
	if (!context) {
		throw new Error("LiquidItem must be used within <Liquid>");
	}
	return context;
}

export type LiquidEase = readonly [number, number, number, number];

export interface LiquidTransition {
	duration?: number;
	ease?: LiquidEase;
}

export interface LiquidProps extends HTMLAttributes<HTMLDivElement> {
	blur?: number;
	contrast?: number;
	edgeColor?: string;
	edgeOpacity?: number;
	edgeWidth?: number;
	fill?: string;
	filterPadding?: number;
}

export const Liquid = forwardRef<HTMLDivElement, LiquidProps>(function Liquid(
	{
		blur = 6,
		contrast = 18,
		fill = "var(--background)",
		edgeColor = "var(--foreground)",
		edgeOpacity = 0.08,
		edgeWidth = 1,
		filterPadding = 24,
		className,
		style,
		children,
		...props
	},
	forwardedRef: Ref<HTMLDivElement>
) {
	const rootRef = useRef<HTMLDivElement>(null);
	const portalRef = useRef<SVGGElement>(null);
	const [size, setSize] = useState({ width: 0, height: 0 });
	const filterId = `liquid-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
	const intercept = Math.round((0.5 - contrast * (5 / 12)) * 100) / 100;
	const padding = Math.ceil(blur * 3 + filterPadding);

	const setRootRef = useCallback(
		(node: HTMLDivElement | null) => {
			rootRef.current = node;
			if (typeof forwardedRef === "function") {
				forwardedRef(node);
			} else if (forwardedRef) {
				forwardedRef.current = node;
			}
		},
		[forwardedRef]
	);

	useLayoutEffect(() => {
		const root = rootRef.current;
		if (!root) {
			return;
		}

		const measure = () => {
			const next = {
				width: root.offsetWidth,
				height: root.offsetHeight,
			};
			setSize((current) =>
				current.width === next.width && current.height === next.height
					? current
					: next
			);
		};

		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(root);
		return () => observer.disconnect();
	}, []);

	const context = useMemo<LiquidContextValue>(
		() => ({
			getRoot: () => rootRef.current,
			getPortal: () => portalRef.current,
		}),
		[]
	);

	return (
		<div
			{...props}
			className={cn("relative isolate", className)}
			ref={setRootRef}
			style={style}
		>
			<svg
				aria-hidden="true"
				className="pointer-events-none absolute inset-0 z-0 size-full overflow-visible"
				focusable="false"
			>
				<defs>
					<filter
						colorInterpolationFilters="sRGB"
						filterUnits="userSpaceOnUse"
						height={size.height + padding * 2}
						id={filterId}
						width={size.width + padding * 2}
						x={-padding}
						y={-padding}
					>
						<feGaussianBlur
							in="SourceGraphic"
							result="blur"
							stdDeviation={blur}
						/>
						<feColorMatrix
							in="blur"
							result="goo"
							type="matrix"
							values={`1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 ${contrast} ${intercept}`}
						/>
						<feComposite
							in="SourceGraphic"
							in2="goo"
							operator="atop"
							result="shape"
						/>
						{edgeWidth > 0 ? (
							<>
								<feColorMatrix
									in="shape"
									result="solid-shape"
									type="matrix"
									values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 60 -29.5"
								/>
								<feMorphology
									in="solid-shape"
									operator="erode"
									radius={edgeWidth}
									result="inset-shape"
								/>
								<feComposite
									in="solid-shape"
									in2="inset-shape"
									operator="out"
									result="edge-mask"
								/>
								<feFlood
									floodColor={edgeColor}
									floodOpacity={edgeOpacity}
									result="edge-color"
								/>
								<feComposite
									in="edge-color"
									in2="edge-mask"
									operator="in"
									result="edge"
								/>
								<feMerge>
									<feMergeNode in="shape" />
									<feMergeNode in="edge" />
								</feMerge>
							</>
						) : null}
					</filter>
				</defs>
				<g fill={fill} filter={`url(#${filterId})`} ref={portalRef} />
			</svg>
			<LiquidContext.Provider value={context}>
				{children}
			</LiquidContext.Provider>
		</div>
	);
});

interface LiquidBox {
	height: number;
	radius: number;
	width: number;
	x: number;
	y: number;
}

export interface LiquidItemProps
	extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
	children: ReactNode;
	height: number;
	radius?: number;
	transition?: LiquidTransition;
	width: number;
	x: number;
	y: number;
}

function mix(from: number, to: number, progress: number) {
	return from + (to - from) * progress;
}

function cubicBezier([x1, y1, x2, y2]: LiquidEase) {
	return (progress: number) => {
		if (progress <= 0) {
			return 0;
		}
		if (progress >= 1) {
			return 1;
		}

		let lower = 0;
		let upper = 1;
		for (let index = 0; index < 20; index++) {
			const time = (lower + upper) / 2;
			const inverse = 1 - time;
			const x =
				3 * inverse * inverse * time * x1 +
				3 * inverse * time * time * x2 +
				time ** 3;
			if (x < progress) {
				lower = time;
			} else {
				upper = time;
			}
		}

		const time = (lower + upper) / 2;
		const inverse = 1 - time;
		return (
			3 * inverse * inverse * time * y1 +
			3 * inverse * time * time * y2 +
			time ** 3
		);
	};
}

export function LiquidItem({
	children,
	x,
	y,
	width,
	height,
	radius = Math.min(width, height) / 2,
	transition,
	className,
	style,
	...props
}: LiquidItemProps) {
	const context = useLiquidContext();
	const reduce = useReducedMotion() ?? false;
	const wrapperRef = useRef<HTMLDivElement>(null);
	const [blob, setBlob] = useState<SVGRectElement | null>(null);
	const currentRef = useRef<LiquidBox | null>(null);
	const duration = reduce ? 0 : (transition?.duration ?? 280);
	const ease = transition?.ease ?? EASE_OUT;
	const [x1, y1, x2, y2] = ease;

	useLayoutEffect(() => {
		const portal = context.getPortal();
		if (!portal) {
			return;
		}

		const blob = document.createElementNS("http://www.w3.org/2000/svg", "rect");
		blob.setAttribute("x", "0");
		blob.setAttribute("y", "0");
		blob.style.transformBox = "fill-box";
		blob.style.transformOrigin = "center";
		blob.style.willChange = "transform";
		portal.append(blob);
		setBlob(blob);

		return () => {
			blob.remove();
		};
	}, [context]);

	useLayoutEffect(() => {
		const wrapper = wrapperRef.current;
		if (!(wrapper && blob && context.getRoot())) {
			return;
		}

		const target = { x, y, width, height, radius };
		const write = (box: LiquidBox) => {
			// Keep the interactive surface and its filtered silhouette on the same
			// frame so neither can visually outrun the other during a morph.
			const transform = `translate(${box.x}px, ${box.y}px)`;
			wrapper.style.transform = transform;
			wrapper.style.width = `${box.width}px`;
			wrapper.style.height = `${box.height}px`;
			blob.style.transform = transform;
			blob.setAttribute("width", String(box.width));
			blob.setAttribute("height", String(box.height));
			blob.setAttribute("rx", String(box.radius));
		};

		const from = currentRef.current;
		if (!from || duration === 0) {
			currentRef.current = target;
			write(target);
			return;
		}

		const easing = cubicBezier([x1, y1, x2, y2]);
		const startedAt = performance.now();
		let frame = 0;

		const tick = (now: number) => {
			const progress = Math.min(1, (now - startedAt) / duration);
			const eased = easing(progress);
			const current = {
				x: mix(from.x, target.x, eased),
				y: mix(from.y, target.y, eased),
				width: mix(from.width, target.width, eased),
				height: mix(from.height, target.height, eased),
				radius: mix(from.radius, target.radius, eased),
			};
			currentRef.current = current;
			write(current);
			if (progress < 1) {
				frame = requestAnimationFrame(tick);
			}
		};

		frame = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(frame);
	}, [blob, context, duration, height, radius, width, x, x1, x2, y, y1, y2]);

	return (
		<div
			{...props}
			className={cn("absolute top-0 left-0 z-10", className)}
			ref={wrapperRef}
			style={{ ...style, willChange: "transform, width, height" }}
		>
			{children}
		</div>
	);
}
