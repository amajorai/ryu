"use client";

import {
	Children,
	type CSSProperties,
	cloneElement,
	Fragment,
	isValidElement,
	type ReactElement,
	type ReactNode,
	useEffect,
	useState,
} from "react";

import { cn } from "../lib/utils.ts";

const DEFAULT_STEP_MS = 40;

// transitions.dev "texts reveal", expressed in Tailwind so there is one source
// of truth and no per-page CSS. Lines start translated-down + blurred +
// invisible and settle to their resting state on mount, each offset by `step`
// ms so the eye lands on the first line first. `transition-[...]` enumerates the
// exact properties (not `all`) so unrelated style changes don't ride in.
const LINE_BASE =
	"transition-[opacity,transform,filter] duration-500 ease-[cubic-bezier(0.22,1,0.36,1)] will-change-transform motion-reduce:transition-none";
const LINE_HIDDEN = "translate-y-3 opacity-0 blur-[3px]";
const LINE_SHOWN = "translate-y-0 opacity-100 blur-[0px]";

interface StaggerRevealProps {
	children: ReactNode;
	/** Extra ms before the first line reveals. */
	startDelay?: number;
	/** Per-line stagger offset in ms. */
	step?: number;
}

interface StyledProps {
	className?: string;
	style?: CSSProperties;
}

/**
 * Staggered blurred-rise entrance for a stack of elements. Each direct child
 * reveals on mount, offset by `step` ms, with a built-in
 * `prefers-reduced-motion` guard. Children are cloned (no wrapper elements) so
 * their layout, `w-full`, and keys are preserved — drop it directly inside the
 * flex/grid column whose children should reveal.
 */
export function StaggerReveal({
	children,
	startDelay = 0,
	step = DEFAULT_STEP_MS,
}: StaggerRevealProps) {
	const [shown, setShown] = useState(false);

	useEffect(() => {
		const frame = requestAnimationFrame(() => setShown(true));
		return () => cancelAnimationFrame(frame);
	}, []);

	// Flatten one level of Fragments so a `cond ? <>…</> : <>…</>` child reveals
	// each of its lines individually instead of as one node. Cloning className /
	// style onto a Fragment is also invalid ("Invalid prop `className` supplied to
	// `React.Fragment`"), so descending into it is both correct and required.
	// Fragment children come from a nested `Children.toArray` whose keys restart
	// at `.0`, so they are namespaced with the Fragment's key to stay unique
	// against the top-level children ("two children with the same key, `.0`").
	const lines: { node: ReactNode; key: string }[] = [];
	for (const child of Children.toArray(children)) {
		if (isValidElement(child) && child.type === Fragment) {
			const fragmentChildren = (child.props as { children?: ReactNode })
				.children;
			for (const inner of Children.toArray(fragmentChildren)) {
				const innerKey = isValidElement(inner) ? inner.key : null;
				lines.push({
					node: inner,
					key: `${child.key}:${innerKey ?? lines.length}`,
				});
			}
		} else {
			const childKey = isValidElement(child) ? child.key : null;
			lines.push({ node: child, key: childKey ?? `${lines.length}` });
		}
	}

	return lines.map(({ node, key }, index) => {
		if (!isValidElement(node)) {
			return node;
		}
		const element = node as ReactElement<StyledProps>;
		return cloneElement(element, {
			key,
			className: cn(
				LINE_BASE,
				shown ? LINE_SHOWN : LINE_HIDDEN,
				element.props.className
			),
			style: {
				...element.props.style,
				transitionDelay: shown ? `${startDelay + index * step}ms` : "0ms",
			},
		});
	});
}
