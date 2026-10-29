import { cn } from "./utils.ts";

/** Construct the native reveal props without asserting the child's prop shape.
 * Class joining and object spread retain native boxing, proxy and accessor behavior. */
export function nativeRevealCloneProps(element, key, revealClass, revealStyle) {
	return {
		key,
		className: cn(revealClass, element.props.className),
		style: { ...element.props.style, ...revealStyle },
	};
}
