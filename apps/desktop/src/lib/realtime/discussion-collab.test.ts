import { describe, expect, test } from "bun:test";
import type { TDiscussion } from "@ryu/ui/components/editor/plugins/discussion-kit.tsx";
import { applyUpdate, Doc, encodeStateAsUpdate } from "yjs";
import { DiscussionCollabStore } from "./discussion-collab.ts";

function synchronize(source: Doc, target: Doc): void {
	applyUpdate(target, encodeStateAsUpdate(source));
}

function discussion(): TDiscussion {
	return {
		comments: [
			{
				contentRich: [{ children: [{ text: "First" }], type: "p" }],
				createdAt: new Date("2026-01-01T00:00:00.000Z"),
				discussionId: "discussion-1",
				id: "comment-1",
				isEdited: false,
				userId: "user-a",
			},
		],
		createdAt: new Date("2026-01-01T00:00:00.000Z"),
		documentContent: "selected text",
		id: "discussion-1",
		isResolved: false,
		userId: "user-a",
	};
}

describe("DiscussionCollabStore", () => {
	test("keeps legacy node transport bytes while decoding the editor's native default elements", () => {
		const document = new Doc();
		const store = new DiscussionCollabStore(document);
		store.writeDiscussions([discussion()]);
		const comments = document.getMap<string>("ryu:discussion-comments");
		const serialized =
			'{"contentRich":[{"children":[{"type":null,"children":[{"text":"Legacy","bold":true,"futureMark":{"__proto__":{"retained":true}}}]}],"future":{"large":1e400}}],"createdAt":"2026-01-01T00:00:00.000Z","discussionId":"discussion-1","id":"comment-1","isEdited":false,"userId":"user-a"}';
		comments.set("discussion-1:comment-1", serialized);
		const raw = store.readStoredDiscussions()[0]?.comments[0]?.contentRich;
		expect(raw).toEqual([
			{
				children: [
					{
						type: null,
						children: [
							{
								text: "Legacy",
								bold: true,
								futureMark: JSON.parse('{"__proto__":{"retained":true}}'),
							},
						],
					},
				],
				future: { large: Number.POSITIVE_INFINITY },
			},
		]);
		expect(store.readDiscussions()[0]?.comments[0]?.contentRich).toEqual([
			{
				type: "",
				children: [
					{
						type: "",
						children: [
							{
								text: "Legacy",
								bold: true,
								futureMark: JSON.parse('{"__proto__":{"retained":true}}'),
							},
						],
					},
				],
				future: { large: Number.POSITIVE_INFINITY },
			},
		]);
		expect(comments.get("discussion-1:comment-1")).toBe(serialized);
		expect(raw?.[0]).not.toHaveProperty("type");
	});

	test("retains future and malformed array payloads on the raw read path without crashing the editor", () => {
		const document = new Doc();
		const store = new DiscussionCollabStore(document);
		store.writeDiscussions([discussion()]);
		const comments = document.getMap<string>("ryu:discussion-comments");
		const futureNodes = [
			{
				type: "future",
				children: [{ text: "Future text" }],
				future: { format: 2 },
			},
		];
		for (const { contentRich, editorValue } of [
			{ contentRich: [{ text: "A root text node" }], editorValue: [] },
			{ contentRich: [1, null, "future"], editorValue: [] },
			{ contentRich: futureNodes, editorValue: futureNodes },
			{ contentRich: [], editorValue: [] },
		]) {
			const serialized = JSON.stringify({
				...discussion().comments[0],
				contentRich,
			});
			comments.set("discussion-1:comment-1", serialized);
			expect(
				store.readStoredDiscussions()[0]?.comments[0]?.contentRich
			).toEqual(contentRich);
			const rendered = store.readDiscussions()[0]?.comments[0]?.contentRich;
			expect(rendered).toEqual(editorValue);
			expect(comments.get("discussion-1:comment-1")).toBe(serialized);
		}
	});

	test("rejects malformed headers and dates without changing any collaboration entry", () => {
		const document = new Doc();
		const store = new DiscussionCollabStore(document);
		store.writeDiscussions([discussion()]);
		const comments = document.getMap<string>("ryu:discussion-comments");
		for (const override of [
			{ createdAt: "invalid" },
			{ isEdited: "false" },
			{ contentRich: {} },
			{ userId: null },
		]) {
			const serialized = JSON.stringify({
				...discussion().comments[0],
				...override,
			});
			comments.set("discussion-1:comment-1", serialized);
			expect(store.readStoredDiscussions()[0]?.comments).toEqual([]);
			expect(store.readDiscussions()[0]?.comments).toEqual([]);
			expect(comments.get("discussion-1:comment-1")).toBe(serialized);
		}
	});

	test("preserves unsupported rich text when saving another discussion field, and permits a deliberate replacement", () => {
		const document = new Doc();
		const store = new DiscussionCollabStore(document);
		store.writeDiscussions([discussion()]);
		const comments = document.getMap<string>("ryu:discussion-comments");
		const rawContent = [
			{ text: "A future root form", future: { revision: 3 } },
		];
		comments.set(
			"discussion-1:comment-1",
			JSON.stringify({ ...discussion().comments[0], contentRich: rawContent })
		);
		const editorSnapshot = store.readDiscussions();
		for (const entry of editorSnapshot) {
			entry.isResolved = true;
		}
		store.writeDiscussions(editorSnapshot);
		expect(store.readStoredDiscussions()[0]?.comments[0]?.contentRich).toEqual(
			rawContent
		);
		expect(store.readStoredDiscussions()[0]?.isResolved).toBe(true);
		for (const entry of editorSnapshot) {
			for (const comment of entry.comments) {
				comment.contentRich = [];
			}
		}
		store.writeDiscussions(editorSnapshot);
		expect(store.readStoredDiscussions()[0]?.comments[0]?.contentRich).toEqual(
			[]
		);
	});

	test("keeps native overflow hues and optional user properties from stored metadata", () => {
		const document = new Doc();
		const store = new DiscussionCollabStore(document);
		const users = document.getMap<string>("ryu:discussion-users");
		const serialized = '{"id":"user-a","name":"Person","hue":1e400}';
		users.set("user-a", serialized);
		expect(store.readUsers()["user-a"]).toEqual({
			avatarUrl: undefined,
			hue: Number.POSITIVE_INFINITY,
			id: "user-a",
			name: "Person",
		});
		expect(Object.keys(store.readUsers()["user-a"] ?? {})).toEqual([
			"avatarUrl",
			"hue",
			"id",
			"name",
		]);
		expect(users.get("user-a")).toBe(serialized);
	});

	test("merges concurrent replies as independent CRDT entries", () => {
		const leftDocument = new Doc();
		const left = new DiscussionCollabStore(leftDocument);
		left.writeDiscussions([discussion()]);

		const rightDocument = new Doc();
		synchronize(leftDocument, rightDocument);
		const right = new DiscussionCollabStore(rightDocument);

		const leftDiscussion = left.readDiscussions()[0];
		const rightDiscussion = right.readDiscussions()[0];
		expect(leftDiscussion).toBeDefined();
		expect(rightDiscussion).toBeDefined();
		if (!(leftDiscussion && rightDiscussion)) {
			throw new Error("seed discussion missing");
		}

		left.writeDiscussions([
			{
				...leftDiscussion,
				comments: [
					...leftDiscussion.comments,
					{
						contentRich: [{ children: [{ text: "Left" }], type: "p" }],
						createdAt: new Date("2026-01-01T00:01:00.000Z"),
						discussionId: leftDiscussion.id,
						id: "comment-left",
						isEdited: false,
						userId: "user-a",
					},
				],
			},
		]);
		right.writeDiscussions([
			{
				...rightDiscussion,
				comments: [
					...rightDiscussion.comments,
					{
						contentRich: [{ children: [{ text: "Right" }], type: "p" }],
						createdAt: new Date("2026-01-01T00:02:00.000Z"),
						discussionId: rightDiscussion.id,
						id: "comment-right",
						isEdited: false,
						userId: "user-b",
					},
				],
			},
		]);

		synchronize(leftDocument, rightDocument);
		synchronize(rightDocument, leftDocument);

		expect(
			left.readDiscussions()[0]?.comments.map((comment) => comment.id)
		).toEqual(["comment-1", "comment-left", "comment-right"]);
		expect(right.readDiscussions()).toEqual(left.readDiscussions());
	});

	test("shares authenticated user metadata", () => {
		const sourceDocument = new Doc();
		const source = new DiscussionCollabStore(sourceDocument);
		source.writeUser({
			avatarUrl: "https://example.test/avatar.png",
			id: "person@example.test",
			name: "Person",
		});

		const targetDocument = new Doc();
		synchronize(sourceDocument, targetDocument);

		expect(new DiscussionCollabStore(targetDocument).readUsers()).toEqual({
			"person@example.test": {
				avatarUrl: "https://example.test/avatar.png",
				id: "person@example.test",
				name: "Person",
			},
		});
	});
});
