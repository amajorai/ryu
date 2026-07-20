import {
	BaseFootnoteDefinitionPlugin,
	BaseFootnoteReferencePlugin,
} from "@platejs/footnote";

import {
	FootnoteDefinitionElementStatic,
	FootnoteReferenceElementStatic,
} from "@ryu/ui/components/editor/ui/footnote-node-static.tsx";

export const BaseFootnoteKit = [
	BaseFootnoteReferencePlugin.withComponent(FootnoteReferenceElementStatic),
	BaseFootnoteDefinitionPlugin.withComponent(FootnoteDefinitionElementStatic),
];
