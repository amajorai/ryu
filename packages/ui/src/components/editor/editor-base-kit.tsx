import { BaseAlignKit } from "./plugins/align-base-kit.tsx";
import { BaseBasicBlocksKit } from "./plugins/basic-blocks-base-kit.tsx";
import { BaseBasicMarksKit } from "./plugins/basic-marks-base-kit.tsx";
import { BaseCalloutKit } from "./plugins/callout-base-kit.tsx";
import { BaseCodeBlockKit } from "./plugins/code-block-base-kit.tsx";
import { BaseColumnKit } from "./plugins/column-base-kit.tsx";
import { BaseCommentKit } from "./plugins/comment-base-kit.tsx";
import { BaseDateKit } from "./plugins/date-base-kit.tsx";
import { BaseFontKit } from "./plugins/font-base-kit.tsx";
import { BaseFootnoteKit } from "./plugins/footnote-base-kit.tsx";
import { BaseLineHeightKit } from "./plugins/line-height-base-kit.tsx";
import { BaseLinkKit } from "./plugins/link-base-kit.tsx";
import { BaseListKit } from "./plugins/list-base-kit.tsx";
import { MarkdownKit } from "./plugins/markdown-kit.tsx";
import { BaseMathKit } from "./plugins/math-base-kit.tsx";
import { BaseMediaKit } from "./plugins/media-base-kit.tsx";
import { BaseMentionKit } from "./plugins/mention-base-kit.tsx";
import { BaseSuggestionKit } from "./plugins/suggestion-base-kit.tsx";
import { BaseTableKit } from "./plugins/table-base-kit.tsx";
import { BaseTocKit } from "./plugins/toc-base-kit.tsx";
import { BaseToggleKit } from "./plugins/toggle-base-kit.tsx";
import { BaseWikiLinkKit } from "./plugins/wikilink-kit.tsx";

export const BaseEditorKit = [
	...BaseBasicBlocksKit,
	...BaseCodeBlockKit,
	...BaseTableKit,
	...BaseToggleKit,
	...BaseTocKit,
	...BaseMediaKit,
	...BaseCalloutKit,
	...BaseColumnKit,
	...BaseMathKit,
	...BaseDateKit,
	...BaseLinkKit,
	...BaseMentionKit,
	...BaseBasicMarksKit,
	...BaseFontKit,
	...BaseListKit,
	...BaseAlignKit,
	...BaseLineHeightKit,
	...BaseCommentKit,
	...BaseSuggestionKit,
	...BaseWikiLinkKit,
	...MarkdownKit,
	...BaseFootnoteKit,
];
