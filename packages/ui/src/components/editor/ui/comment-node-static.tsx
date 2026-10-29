import type { TCommentText } from "platejs";
import type { SlateLeafProps } from "platejs/static";
import { SlateLeaf } from "platejs/static";

export function CommentLeafStatic(props: SlateLeafProps<TCommentText>) {
	return (
		<SlateLeaf {...props} className="ryu-editor-comment-static border-b-2">
			{props.children}
		</SlateLeaf>
	);
}
