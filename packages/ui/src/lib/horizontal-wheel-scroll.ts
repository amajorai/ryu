import { z } from "zod";

const HORIZONTAL_SCROLL_SLACK = 1;
const WHEEL_LINE_HEIGHT = 16;

const SCROLLABLE_OVERFLOW_X = new Set(["auto", "overlay", "scroll"]);

export interface HorizontalWheelElement {
	clientHeight: number;
	clientWidth: number;
	parentElement?: unknown;
	scrollHeight: number;
	scrollLeft: number;
	scrollWidth: number;
}

export interface HorizontalWheelEvent {
	ctrlKey: boolean;
	defaultPrevented: boolean;
	deltaMode: number;
	deltaX: number;
	deltaY: number;
	preventDefault: () => void;
	target: unknown;
}

type OverflowXReader = (element: HorizontalWheelElement) => string;
/** The listener installer needs event ownership, rather than the whole DOM. */
export type HorizontalWheelDocument = Pick<
	Document,
	"addEventListener" | "removeEventListener"
>;

// Scroll geometry is browser-owned; retain the original number semantics (even
// non-finite dimensions) and, critically, the mutable element's identity.
const wheelDimensionSchema = z.union([
	z.number(),
	z.nan(),
	z.literal(Number.POSITIVE_INFINITY),
	z.literal(Number.NEGATIVE_INFINITY),
]);
const horizontalWheelDimensionsSchema = z.object({
	clientHeight: wheelDimensionSchema,
	clientWidth: wheelDimensionSchema,
	scrollHeight: wheelDimensionSchema,
	scrollLeft: wheelDimensionSchema,
	scrollWidth: wheelDimensionSchema,
});
const horizontalWheelElementSchema = z.custom<HorizontalWheelElement>(
	(value) => horizontalWheelDimensionsSchema.safeParse(value).success
);
const wheelTargetParentSchema = z.object({
	parentElement: z.unknown().optional(),
});
const computedStyleReaderSchema = z.custom<typeof globalThis.getComputedStyle>(
	(value) => z.function().safeParse(value).success
);
const computedOverflowSchema = z.object({ overflowX: z.string() });
const elementConstructorSchema = z.custom<typeof Element>(
	(value) => z.function().safeParse(value).success
);
const elementOwnerConstructorSchema = z.object({
	ownerDocument: z.object({
		defaultView: z.object({ Element: elementConstructorSchema }),
	}),
});
/** Use the owner's constructor too, so genuine iframe elements remain eligible. */
const computedStyleElementSchema = z.custom<Element>((value) => {
	const local = elementConstructorSchema.safeParse(globalThis.Element);
	if (local.success && z.instanceof(local.data).safeParse(value).success) {
		return true;
	}
	const owner = elementOwnerConstructorSchema.safeParse(value);
	return (
		owner.success &&
		z.instanceof(owner.data.ownerDocument.defaultView.Element).safeParse(value)
			.success
	);
});

/** Convert a wheel delta into pixels without changing the browser's direction. */
export function normalizeWheelDelta(
	delta: number,
	deltaMode: number,
	viewportSize: number
): number {
	if (deltaMode === 1) {
		return delta * WHEEL_LINE_HEIGHT;
	}
	if (deltaMode === 2) {
		return delta * viewportSize;
	}
	return delta;
}

/**
 * Create the delegated wheel handler. The reader is injectable so the event
 * rules can be tested with structural elements without requiring a DOM shim.
 */
export function createHorizontalWheelHandler(
	getOverflowX: OverflowXReader = readOverflowX
): (event: HorizontalWheelEvent) => void {
	return (event) => {
		if (
			event.defaultPrevented ||
			event.ctrlKey ||
			event.deltaY === 0 ||
			!Number.isFinite(event.deltaY) ||
			!Number.isFinite(event.deltaX)
		) {
			return;
		}

		const firstElement = elementFromTarget(event.target);
		if (!firstElement) {
			return;
		}

		const visited = new Set<HorizontalWheelElement>();
		let candidate: HorizontalWheelElement | null = firstElement;
		while (candidate && !visited.has(candidate)) {
			visited.add(candidate);
			if (isEligibleScroller(candidate, getOverflowX)) {
				const delta =
					normalizeWheelDelta(
						event.deltaX,
						event.deltaMode,
						candidate.clientWidth
					) +
					normalizeWheelDelta(
						event.deltaY,
						event.deltaMode,
						candidate.clientHeight
					);

				if (delta !== 0 && moveScrollLeft(candidate, delta)) {
					event.preventDefault();
					return;
				}
			}
			candidate = parentElementOf(candidate);
		}
	};
}

const installedDocuments = new WeakMap<HorizontalWheelDocument, () => void>();

/** Install the wheel adapter once for a browser document. */
export function installHorizontalWheelScrolling(
	targetDocument?: HorizontalWheelDocument
): () => void {
	const ownerDocument =
		targetDocument ?? (globalThis.document === undefined ? null : document);
	if (!ownerDocument || installedDocuments.has(ownerDocument)) {
		return () => {};
	}

	const handler = createHorizontalWheelHandler();
	const listener = (event: WheelEvent) => handler(event);
	ownerDocument.addEventListener("wheel", listener, { passive: false });

	const cleanup = () => {
		if (!installedDocuments.has(ownerDocument)) {
			return;
		}
		ownerDocument.removeEventListener("wheel", listener);
		installedDocuments.delete(ownerDocument);
	};
	installedDocuments.set(ownerDocument, cleanup);
	return cleanup;
}

function isEligibleScroller(
	element: HorizontalWheelElement,
	getOverflowX: OverflowXReader
): boolean {
	const overflowX = getOverflowX(element).trim().toLowerCase();
	const hasHorizontalOverflow =
		element.scrollWidth - element.clientWidth > HORIZONTAL_SCROLL_SLACK;
	const hasVerticalOverflow =
		element.scrollHeight - element.clientHeight > HORIZONTAL_SCROLL_SLACK;

	return (
		hasHorizontalOverflow &&
		!hasVerticalOverflow &&
		SCROLLABLE_OVERFLOW_X.has(overflowX)
	);
}

function moveScrollLeft(
	element: HorizontalWheelElement,
	delta: number
): boolean {
	const before = element.scrollLeft;
	element.scrollLeft += delta;
	return element.scrollLeft !== before;
}

function readOverflowX(element: HorizontalWheelElement): string {
	const reader = computedStyleReaderSchema.safeParse(
		globalThis.getComputedStyle
	);
	if (!reader.success) {
		return "";
	}
	// The native DOM call validates its element argument, including elements from
	// another realm. Decode only the computed-style projection this adapter owns.
	return computedOverflowSchema.parse(
		reader.data.call(globalThis, computedStyleElementSchema.parse(element))
	).overflowX;
}

const wheelEventTargetSchema = z
	.union([
		horizontalWheelElementSchema,
		wheelTargetParentSchema.transform((parent) =>
			asHorizontalWheelElement(parent.parentElement)
		),
	])
	.nullable()
	.catch(null);
const elementFromTarget = wheelEventTargetSchema.parse;

function parentElementOf(
	element: HorizontalWheelElement
): HorizontalWheelElement | null {
	return asHorizontalWheelElement(element.parentElement);
}

const asHorizontalWheelElement = horizontalWheelElementSchema
	.nullable()
	.catch(null).parse;
