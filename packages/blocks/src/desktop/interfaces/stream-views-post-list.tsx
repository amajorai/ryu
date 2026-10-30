import type { StreamPost } from "./stream-model.ts";
import { type StreamPostActions, StreamPostItem } from "./stream-post.tsx";

export function PostList({
	actions,
	posts,
}: {
	actions: StreamPostActions;
	posts: StreamPost[];
}) {
	return (
		<ul className="flex flex-col">
			{posts.map((post) => (
				<li key={post.threadId}>
					<StreamPostItem actions={actions} post={post} />
				</li>
			))}
		</ul>
	);
}
