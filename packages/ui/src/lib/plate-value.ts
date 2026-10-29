import {
	type Descendant,
	ElementApi,
	type TElement,
	TextApi,
	type Value,
} from "platejs";
import { z } from "zod";

const elementTypeSchema = z.string();

/** Refine the complete child tree, retaining native plugin properties and nodes. */
function normalizeElement(
	input: TElement,
	ancestors: WeakSet<object>
): TElement | null {
	if (ancestors.has(input)) {
		return null;
	}
	ancestors.add(input);
	const children: Descendant[] = [];
	const elementType = elementTypeSchema.safeParse(input.type);
	let changed = !elementType.success;
	for (const child of input.children) {
		const normalized = TextApi.isText(child)
			? child
			: ElementApi.isElement(child)
				? normalizeElement(child, ancestors)
				: null;
		if (!normalized) {
			ancestors.delete(input);
			return null;
		}
		children.push(normalized);
		changed ||= normalized !== child;
	}
	ancestors.delete(input);
	return changed
		? { ...input, children, type: elementType.success ? elementType.data : "" }
		: input;
}

function normalizeValue(input: Value): Value | null {
	const normalized: Value = [];
	const ancestors = new WeakSet<object>();
	let changed = false;
	for (const element of input) {
		const result = normalizeElement(element, ancestors);
		if (!result) {
			return null;
		}
		normalized.push(result);
		changed ||= result !== element;
	}
	return changed ? normalized : input;
}

/**
 * Decode at the editor boundary, while raw collaboration records remain intact.
 * Plate renders legacy untyped elements through its default div renderer. An
 * empty type preserves that route; a paragraph type would change their styling.
 * Typed trees keep their original array, node, mark and native metadata identity.
 */
export const plateValueSchema = z
	.unknown()
	.transform((input, context): Value => {
		try {
			const value = ElementApi.isElementList(input)
				? normalizeValue(input)
				: null;
			if (value) {
				return value;
			}
		} catch {
			// Native getters and malformed Slate nodes must fail this input boundary.
		}
		context.addIssue({
			code: "custom",
			message: "Expected a complete Plate element tree",
		});
		return z.NEVER;
	});
