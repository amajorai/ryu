export const REACTION_MESSAGE_ID = "56093e30-7437-4f4c-8509-39c3842376b4";
export const REACTION_ACTION = {
	args: { dispatch: "reactions.toggle", renderer: "reaction-picker" },
	capability: "reactions.toggle",
	icon: "smile",
	id: "reactions.picker",
	kind: "menu",
	label: "Add reaction",
	order: 100,
	plugin: "@ryu/reactions",
	target: "any",
};
export function createReactionHttpFixture(conversationId: string) {
	const owned = new Map<string, string[]>();
	const listPath = `/api/conversations/${conversationId}/reactions`;
	const writePath = `/api/conversations/${conversationId}/messages/${REACTION_MESSAGE_ID}/reactions`;
	return {
		reset() {
			owned.clear();
		},
		snapshot() {
			return Object.fromEntries(
				[...owned].map(([node, emojis]) => [node, [...emojis]])
			);
		},
		matches(method: string, path: string) {
			return (
				(method === "GET" && path === listPath) ||
				(["POST", "DELETE"].includes(method) && path === writePath)
			);
		},
		handle(node: "a" | "b", method: string, body: unknown) {
			const emojis = owned.get(node) ?? [];
			if (method === "GET")
				return {
					reactions: emojis.map((emoji) => ({
						message_id: REACTION_MESSAGE_ID,
						emoji,
						count: 1,
						reacted_by_me: true,
					})),
				};
			if (
				!body ||
				typeof body !== "object" ||
				Array.isArray(body) ||
				Object.keys(body).length !== 1 ||
				!("emoji" in body) ||
				!["👍", "🎉"].includes(String(body.emoji))
			)
				return null;
			const emoji = String(body.emoji);
			owned.set(
				node,
				method === "POST"
					? [...new Set([...emojis, emoji])]
					: emojis.filter((value) => value !== emoji)
			);
			return { ok: true, message_id: REACTION_MESSAGE_ID, emoji };
		},
	};
}
