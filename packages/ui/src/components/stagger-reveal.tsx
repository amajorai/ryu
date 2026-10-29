"use client";

import {
	Children,
	type CSSProperties,
	cloneElement,
	Fragment,
	isValidElement,
	type ReactNode,
	useEffect,
	useState,
} from "react";
import { nativeRevealCloneProps } from "../lib/native-reveal-clone-props.mjs";
import { cn } from "../lib/utils.ts";

/**
 * The offset between two consecutive lines. Exported so a surface that splits
 * its cascade across more than one `StaggerReveal` — a header block and the
 * content block under it, say — can carry on counting in the same units rather
 * than inventing a second rhythm.
 */
export const STAGGER_STEP_MS = 40;

const DEFAULT_STEP_MS = STAGGER_STEP_MS;

// transitions.dev "texts reveal", expressed in Tailwind so there is one source
// of truth and no per-page CSS. Lines start translated-down + blurred +
// invisible and settle to their resting state on mount, each offset by `step`
// ms so the eye lands on the first line first. `transition-[...]` enumerates the
// exact properties (not `all`) so unrelated style changes don't ride in.
const LINE_BASE =
	"[transition-delay:var(--reveal-delay)] transition-[opacity,transform,filter] duration-500 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none";
const LINE_HIDDEN = "translate-y-3 opacity-0 blur-[3px]";
const LINE_SHOWN = "translate-y-0 opacity-100 blur-[0px]";

interface StaggerRevealStyle extends CSSProperties {
	"--reveal-delay": string;
}

interface StaggerRevealProps {
	children: ReactNode;
	/** Extra ms before the first line reveals. */
	startDelay?: number;
	/** Per-line stagger offset in ms. */
	step?: number;
	/**
	 * Carry the reveal on a plain wrapper `<div>` per line instead of cloning it
	 * onto the line itself.
	 *
	 * The default (clone) is right for lines that are DOM elements, but a line
	 * that is a *component* only animates if it forwards BOTH `className` and
	 * `style` to its own root — and one that forwards neither, or forwards
	 * `className` to some inner node, fails silently: the line just appears. Turn
	 * this on wherever the lines are components (settings cards, sliders,
	 * selects) rather than auditing each one.
	 *
	 * The cost is one block-level element per line. That is invisible inside a
	 * flex column, but it DOES swallow a child's own grid placement, so leave it
	 * off when the lines are grid cells carrying `col-span-*`.
	 */
	wrap?: boolean;
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
	wrap = false,
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
		if (
			isValidElement<React.ComponentProps<typeof Fragment>>(child) &&
			child.type === Fragment
		) {
			const fragmentChildren = child.props.children;
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
		const revealClass = cn(LINE_BASE, shown ? LINE_SHOWN : LINE_HIDDEN);
		const revealStyle: StaggerRevealStyle = {
			"--reveal-delay": shown ? `${startDelay + index * step}ms` : "0ms",
		};

		if (wrap) {
			return (
				<div className={revealClass} key={key} style={revealStyle}>
					{node}
				</div>
			);
		}

		if (!isValidElement(node)) {
			return node;
		}
		const cloneStyle: StaggerRevealStyle = {
			"--reveal-delay": revealStyle["--reveal-delay"],
		};
		const cloneProps = nativeRevealCloneProps(
			node,
			key,
			revealClass,
			cloneStyle
		);
		return cloneElement(node, cloneProps);
	});
}
