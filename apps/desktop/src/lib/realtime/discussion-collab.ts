import type { TDiscussion } from "@ryu/ui/components/editor/plugins/discussion-kit.tsx";
import type { TComment } from "@ryu/ui/components/editor/ui/comment.tsx";
import { plateValueSchema } from "@ryu/ui/lib/plate-value.ts";
import type { Doc, Map as YMap } from "yjs";
import {
	discussionDateSchema,
	discussionJsonTextSchema,
	discussionMetadataSchema,
	discussionUserSchema,
	type StoredDiscussion,
	type StoredDiscussionComment,
	storedDiscussionCommentSchema,
} from "./discussion-wire-contracts.ts";

const DISCUSSIONS_MAP = "ryu:discussion-meta";
const COMMENTS_MAP = "ryu:discussion-comments";
const USERS_MAP = "ryu:discussion-users";

interface DiscussionMetadataWire {
	createdAt: string;
	documentContent?: string;
	id: string;
	isResolved: boolean;
	userId: string;
}

interface CommentWire extends Omit<TComment, "createdAt" | "contentRich"> {
	contentRich: TComment["contentRich"] | StoredDiscussionComment["contentRich"];
	createdAt: string;
	updatedAt?: string;
}

export interface DiscussionUser {
	avatarUrl?: string;
	hue?: number;
	id: string;
	name: string;
}

function parseMetadata(value: string) {
	return (
		discussionJsonTextSchema.pipe(discussionMetadataSchema).safeParse(value)
			.data ?? null
	);
}

function parseComment(value: string) {
	return (
		discussionJsonTextSchema
			.pipe(storedDiscussionCommentSchema)
			.safeParse(value).data ?? null
	);
}

function parseUser(value: string) {
	const user = discussionJsonTextSchema
		.pipe(discussionUserSchema)
		.safeParse(value).data;
	return user
		? { avatarUrl: user.avatarUrl, hue: user.hue, id: user.id, name: user.name }
		: null;
}

function commentKey(comment: TComment): string {
	return `${comment.discussionId}:${comment.id}`;
}

export class DiscussionCollabStore {
	private readonly storedEditorFallbacks = new WeakMap<
		TComment["contentRich"],
		StoredDiscussionComment["contentRich"]
	>();
	private readonly comments: YMap<string>;
	private readonly discussions: YMap<string>;
	private readonly users: YMap<string>;

	constructor(private readonly document: Doc) {
		this.comments = document.getMap<string>(COMMENTS_MAP);
		this.discussions = document.getMap<string>(DISCUSSIONS_MAP);
		this.users = document.getMap<string>(USERS_MAP);
	}

	readStoredDiscussions(): StoredDiscussion[] {
		const commentsByDiscussion = new Map<string, StoredDiscussionComment[]>();
		for (const value of this.comments.values()) {
			const comment = parseComment(value);
			if (!comment) {
				continue;
			}
			const comments = commentsByDiscussion.get(comment.discussionId) ?? [];
			comments.push(comment);
			commentsByDiscussion.set(comment.discussionId, comments);
		}

		const result: StoredDiscussion[] = [];
		for (const value of this.discussions.values()) {
			const metadata = parseMetadata(value);
			const createdAt = metadata
				? discussionDateSchema.safeParse(metadata.createdAt).data
				: undefined;
			if (!(metadata && createdAt)) {
				continue;
			}
			const comments = commentsByDiscussion.get(metadata.id) ?? [];
			comments.sort(
				(left, right) => left.createdAt.valueOf() - right.createdAt.valueOf()
			);
			result.push({
				comments,
				createdAt,
				documentContent: metadata.documentContent,
				id: metadata.id,
				isResolved: metadata.isResolved,
				userId: metadata.userId,
			});
		}
		return result.sort(
			(left, right) => left.createdAt.valueOf() - right.createdAt.valueOf()
		);
	}

	readDiscussions(): TDiscussion[] {
		return this.readStoredDiscussions().map((discussion) => ({
			...discussion,
			comments: discussion.comments.map((comment) => {
				const decoded = plateValueSchema.safeParse(comment.contentRich);
				if (decoded.success) {
					return { ...comment, contentRich: decoded.data };
				}
				const contentRich: TComment["contentRich"] = [];
				this.storedEditorFallbacks.set(contentRich, comment.contentRich);
				return { ...comment, contentRich };
			}),
		}));
	}

	readUsers() {
		const result: Record<string, DiscussionUser> = {};
		for (const value of this.users.values()) {
			const user = parseUser(value);
			if (user) {
				result[user.id] = user;
			}
		}
		return result;
	}

	writeDiscussions(discussions: TDiscussion[]): void {
		this.document.transact(() => {
			const discussionIds = new Set(
				discussions.map((discussion) => discussion.id)
			);
			const commentIds = new Set(
				discussions.flatMap((discussion) => discussion.comments.map(commentKey))
			);

			for (const id of this.discussions.keys()) {
				if (!discussionIds.has(id)) {
					this.discussions.delete(id);
				}
			}
			for (const id of this.comments.keys()) {
				if (!commentIds.has(id)) {
					this.comments.delete(id);
				}
			}

			for (const discussion of discussions) {
				const metadata: DiscussionMetadataWire = {
					createdAt: discussion.createdAt.toISOString(),
					documentContent: discussion.documentContent,
					id: discussion.id,
					isResolved: discussion.isResolved,
					userId: discussion.userId,
				};
				this.discussions.set(discussion.id, JSON.stringify(metadata));
				for (const comment of discussion.comments) {
					const storedFallback =
						comment.contentRich.length === 0
							? this.storedEditorFallbacks.get(comment.contentRich)
							: undefined;
					const wire: CommentWire = {
						...comment,
						contentRich: storedFallback ?? comment.contentRich,
						createdAt: comment.createdAt.toISOString(),
					};
					this.comments.set(commentKey(comment), JSON.stringify(wire));
				}
			}
		});
	}

	writeUser(user: DiscussionUser): void {
		this.users.set(user.id, JSON.stringify(user));
	}

	observe(onChange: () => void): () => void {
		let active = true;
		let queued = false;
		const queueChange = () => {
			if (queued) {
				return;
			}
			queued = true;
			queueMicrotask(() => {
				queued = false;
				if (active) {
					onChange();
				}
			});
		};
		this.comments.observe(queueChange);
		this.discussions.observe(queueChange);
		this.users.observe(queueChange);
		return () => {
			active = false;
			this.comments.unobserve(queueChange);
			this.discussions.unobserve(queueChange);
			this.users.unobserve(queueChange);
		};
	}
}
