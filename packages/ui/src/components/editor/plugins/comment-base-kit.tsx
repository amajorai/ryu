import { BaseCommentPlugin } from "@platejs/comment";

import { CommentLeafStatic } from "@ryu/ui/components/editor/ui/comment-node-static.tsx";

export const BaseCommentKit = [
	BaseCommentPlugin.withComponent(CommentLeafStatic),
];
