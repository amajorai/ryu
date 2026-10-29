"use client";

import { BlockDiscussion } from "@ryu/ui/components/editor/ui/block-discussion.tsx";
import type { TComment } from "@ryu/ui/components/editor/ui/comment.tsx";
import { createPlatePlugin } from "platejs/react";

export interface TDiscussion {
	comments: TComment[];
	createdAt: Date;
	documentContent?: string;
	id: string;
	isResolved: boolean;
	userId: string;
}

interface DiscussionUser {
	avatarUrl?: string;
	hue?: number;
	id: string;
	name: string;
}

interface DiscussionOptions {
	currentUserId: string;
	discussions: TDiscussion[];
	onDiscussionsChange?: (discussions: TDiscussion[]) => void;
	users: Record<string, DiscussionUser>;
}

const BLOCK_SUGGESTION_SELECTOR = '[data-block-suggestion="true"]';

const getTargetElement = (target: EventTarget | null) => {
	if (target instanceof HTMLElement) {
		return target;
	}
	if (target instanceof Node) {
		return target.parentElement;
	}

	return null;
};

export const getDiscussionClickTarget = ({
	selector,
	target,
}: {
	selector: string;
	target: EventTarget | null;
}) => {
	const element = getTargetElement(target);

	if (!element) {
		return null;
	}

	return element.closest(selector);
};

export const getDiscussionBlockClickTarget = ({
	selector = BLOCK_SUGGESTION_SELECTOR,
	target,
}: {
	selector?: string;
	target: EventTarget | null;
}) =>
	getDiscussionClickTarget({
		selector,
		target,
	});

export const discussionPlugin = createPlatePlugin<
	"discussion",
	DiscussionOptions
>({
	key: "discussion",
	options: {
		currentUserId: "local-user",
		discussions: [],
		onDiscussionsChange: undefined,
		users: {
			"local-user": {
				id: "local-user",
				name: "Local user",
			},
		},
	},
})
	.configure({
		render: { aboveNodes: BlockDiscussion },
	})
	.extendSelectors(({ getOption }) => ({
		currentUser: () => getOption("users")[getOption("currentUserId")],
		user: (id: string) => getOption("users")[id],
	}));

export const DiscussionKit = [discussionPlugin];
