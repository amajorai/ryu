// The providers SignedInShell (src/boot/SignedInShell.tsx) and Layout
// (src/components/layout/Layout.tsx) mount around the desktop shell, in the same
// order, for proof harnesses that render one shell surface on its own. Harnesses
// used to hand-build these contexts and fell behind whenever the shell grew a
// provider; mounting the real ones keeps every context field (and its default
// requests) present. Each layer past the QueryClient and app surface is opt-in so a
// harness mounts only what the component under test reads, and the requests a layer
// makes are answered from shell-bootstrap-routes.ts for the paths a spec lists.
import { type QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ReactNode, use, useMemo } from "react";
import { AuthProvider } from "../../contexts/auth-context.tsx";
import {
	type AppSurface,
	AppSurfaceProvider,
} from "../../src/contexts/app-surface-context.tsx";
import { ChatHistoryProvider } from "../../src/contexts/ChatHistoryContext.tsx";
import { EntitlementProvider } from "../../src/contexts/entitlement-context.tsx";
import {
	type InitialTab,
	TabsContext,
	TabsProvider,
	TabsStateProvider,
} from "../../src/contexts/TabsContext.tsx";
import {
	hydrateSealedLocalStorage,
	sealedLocalStorage,
} from "../../src/lib/content-seal.ts";

export type ShellTabsValue = NonNullable<React.ContextType<typeof TabsContext>>;

export interface ShellProofProvidersProps {
	/** Mount AuthProvider, as SignedInShell does above the entitlement gate. */
	auth?: boolean;
	/** Mount the real ChatHistoryProvider on the active node (Layout). */
	chatHistory?: boolean;
	children: ReactNode;
	/** Mount EntitlementProvider (SignedInShell). TabsProvider reads it, so it
	 *  defaults to on whenever `tabs` is. */
	entitlement?: boolean;
	/** Observe the real Tabs value: return it with operations wrapped to record
	 *  proof events. Every other field stays the provider's own. */
	observeTabs?: (value: ShellTabsValue) => ShellTabsValue;
	queryClient: QueryClient;
	surface?: AppSurface;
	/** Mount the real TabsProvider (Layout); an object seeds its initial tab. */
	tabs?: boolean | InitialTab;
}

function ObservedTabs({
	children,
	observe,
}: {
	children: ReactNode;
	observe: (value: ShellTabsValue) => ShellTabsValue;
}) {
	const value = use(TabsContext);
	if (!value) {
		throw new Error("ObservedTabs must render inside TabsProvider");
	}
	const observed = useMemo(() => observe(value), [observe, value]);
	return <TabsStateProvider value={observed}>{children}</TabsStateProvider>;
}

export function ShellProofProviders({
	auth = false,
	chatHistory = false,
	children,
	entitlement,
	observeTabs,
	queryClient,
	surface = "desktop",
	tabs = false,
}: ShellProofProvidersProps) {
	let tree = children;
	if (chatHistory) {
		tree = <ChatHistoryProvider>{tree}</ChatHistoryProvider>;
	}
	if (tabs) {
		if (observeTabs) {
			tree = <ObservedTabs observe={observeTabs}>{tree}</ObservedTabs>;
		}
		tree = (
			<TabsProvider initialTab={tabs === true ? undefined : tabs}>
				{tree}
			</TabsProvider>
		);
	}
	if (entitlement ?? Boolean(tabs)) {
		tree = <EntitlementProvider>{tree}</EntitlementProvider>;
	}
	if (auth) {
		tree = <AuthProvider>{tree}</AuthProvider>;
	}
	return (
		<QueryClientProvider client={queryClient}>
			<AppSurfaceProvider surface={surface}>{tree}</AppSurfaceProvider>
		</QueryClientProvider>
	);
}

/** The global a spec reads sealed localStorage through (see prepareShellProof). */
export const SEALED_READER_GLOBAL = "__readSealedLocalStorage";

/**
 * Run before the first render, as main.tsx does: hydrate sealed localStorage so a
 * reload restores the sealed session and workbench layout, and expose the app's
 * own sealed reader so a spec can read `ryu_session_tabs` (stored sealed under
 * `ryu-sealed:`) the way a restart would. The harness's Vite config needs
 * browserContentKeyHost() for the content key.
 */
export async function prepareShellProof() {
	Object.defineProperty(window, SEALED_READER_GLOBAL, {
		value: (key: string) => sealedLocalStorage.getItem(key),
	});
	await hydrateSealedLocalStorage();
}
