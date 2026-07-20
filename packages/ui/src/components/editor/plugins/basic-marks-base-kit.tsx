import {
	BaseBoldPlugin,
	BaseCodePlugin,
	BaseHighlightPlugin,
	BaseItalicPlugin,
	BaseKbdPlugin,
	BaseStrikethroughPlugin,
	BaseSubscriptPlugin,
	BaseSuperscriptPlugin,
	BaseUnderlinePlugin,
} from "@platejs/basic-nodes";

import { CodeLeafStatic } from "@ryu/ui/components/editor/ui/code-node-static.tsx";
import { HighlightLeafStatic } from "@ryu/ui/components/editor/ui/highlight-node-static.tsx";
import { KbdLeafStatic } from "@ryu/ui/components/editor/ui/kbd-node-static.tsx";

export const BaseBasicMarksKit = [
	BaseBoldPlugin,
	BaseItalicPlugin,
	BaseUnderlinePlugin,
	BaseCodePlugin.withComponent(CodeLeafStatic),
	BaseStrikethroughPlugin,
	BaseSubscriptPlugin,
	BaseSuperscriptPlugin,
	BaseHighlightPlugin.withComponent(HighlightLeafStatic),
	BaseKbdPlugin.withComponent(KbdLeafStatic),
];
