import { isValidElement, type ReactNode } from "react";
import type { MentionTarget } from "@/src/lib/mentions/types.ts";

/** A composer "@" candidate as ChatPage hands it to the transcript. */
export interface ResolvedMentionItem {
	accentColor?: string;
	icon?: ReactNode;
	id: string;
	kind: string;
	label: string;
	ownerId?: string;
	target?: MentionTarget;
	visualIcon?: ReactNode;
}

function sameProps(left: object, right: object): boolean {
	const leftKeys = Object.keys(left);
	return (
		leftKeys.length === Object.keys(right).length &&
		leftKeys.every((key) =>
			Object.is(Reflect.get(left, key), Reflect.get(right, key))
		)
	);
}

/** Two icon nodes draw the same thing: one node, or same-type elements with equal props. */
function sameNode(left: ReactNode, right: ReactNode): boolean {
	if (Object.is(left, right)) {
		return true;
	}
	if (!(isValidElement(left) && isValidElement(right))) {
		return false;
	}
	return (
		left.type === right.type &&
		left.key === right.key &&
		sameProps(left.props as object, right.props as object)
	);
}

function sameTarget(left?: MentionTarget, right?: MentionTarget): boolean {
	if (left === right) {
		return true;
	}
	return (
		left?.path === right?.path &&
		left?.options?.conversationId === right?.options?.conversationId
	);
}

function sameMentionItem(
	left: ResolvedMentionItem,
	right: ResolvedMentionItem
): boolean {
	return (
		left.id === right.id &&
		left.kind === right.kind &&
		left.label === right.label &&
		left.ownerId === right.ownerId &&
		left.accentColor === right.accentColor &&
		sameTarget(left.target, right.target) &&
		sameNode(left.icon, right.icon) &&
		sameNode(left.visualIcon, right.visualIcon)
	);
}

/**
 * Keep last render's mention list when every candidate is unchanged. The list
 * is rebuilt (fresh icon elements included) whenever any mention source changes
 * identity, which happens on every ChatPage render, and the transcript memoises
 * each settled turn on the list's identity.
 */
export function reuseEqualMentionItems<T extends ResolvedMentionItem>(
	previous: readonly T[],
	next: T[]
): T[] {
	if (
		previous.length === next.length &&
		previous.every((item, index) => {
			const other = next[index];
			return other !== undefined && sameMentionItem(item, other);
		})
	) {
		return previous as T[];
	}
	return next;
}
