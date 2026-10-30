import type { ContextType } from "react";
import type { TabsContext } from "@/src/contexts/TabsContext.tsx";

/** The tabs context value, for typing the `openTab` and `activateTab` handles the
 *  Library page passes down to its hooks. */
export type LibraryTabsValue = NonNullable<ContextType<typeof TabsContext>>;
