import type { Attributes, CSSProperties, Key, ReactElement } from "react";

/** The actual constructed props publisher owns only its authored output fields.
 * It does not classify or validate arbitrary child class/style inputs. */
export function nativeRevealCloneProps(
	element: ReactElement,
	key: Key,
	revealClass: string,
	revealStyle: CSSProperties
): Attributes & { className: string; style: object };
