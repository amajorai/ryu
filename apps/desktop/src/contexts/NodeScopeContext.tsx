// apps/desktop/src/contexts/NodeScopeContext.tsx
//
// Dialog-local computer scope. A surface that configures one computer (the node
// settings dialog) wraps its body in a `NodeScopeProvider` naming that computer;
// `useActiveNode()` and its getter/target variants then resolve to it ahead of
// the tab override and the app-wide default. Outside a provider the scope is
// `undefined` and node resolution is exactly the app-wide behaviour.
//
// Kept out of `hooks/useActiveNode.ts` on purpose: many tests replace that
// module with a mock exporting only `useActiveNode`, and a provider living there
// would vanish under those mocks.

import { createContext, type ReactNode, useContext } from "react";

const NodeScopeContext = createContext<string | undefined>(undefined);

export function NodeScopeProvider({
	nodeName,
	children,
}: {
	children: ReactNode;
	nodeName?: string;
}) {
	return (
		<NodeScopeContext.Provider value={nodeName}>
			{children}
		</NodeScopeContext.Provider>
	);
}

/** The computer name the surrounding surface is scoped to, if any. */
export function useNodeScope(): string | undefined {
	return useContext(NodeScopeContext);
}
