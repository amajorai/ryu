import { BaseTocPlugin } from "@platejs/toc";

import { TocElementStatic } from "@ryu/ui/components/editor/ui/toc-node-static.tsx";

export const BaseTocKit = [BaseTocPlugin.withComponent(TocElementStatic)];
