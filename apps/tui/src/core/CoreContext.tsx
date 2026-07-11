/* @jsxImportSource @opentui/react */
// CoreContext exposes the active Ryu Core node ({ url, token }) to every tab.
//
// Tabs never read the environment or build a target themselves; they call
// useCore() to get the live ApiTarget plus a setter the Account/Services tabs can
// use to point the whole app at a different node. The provider seeds itself from
// buildTarget() (env) so a bare launch talks to local Core on :7980.

import type { ApiTarget } from "@ryuhq/core-client/client";
import {
	createContext,
	type ReactNode,
	useContext,
	useMemo,
	useState,
} from "react";
import { buildTarget } from "./target.ts";

interface CoreContextValue {
	/** Point the app at a different node (multi-node switch). */
	setTarget: (next: ApiTarget) => void;
	/** The active node as an ApiTarget. Recomputed only when url/token change. */
	target: ApiTarget;
	/** Active node bearer token, or null when unauthenticated. */
	token: string | null;
	/** Active node base URL (primitive, safe to use in hook deps). */
	url: string;
}

const CoreContext = createContext<CoreContextValue | null>(null);

export function CoreProvider({
	children,
	initial,
}: {
	children: ReactNode;
	initial?: ApiTarget;
}) {
	const [target, setTarget] = useState<ApiTarget>(initial ?? buildTarget());
	// Expose url/token as primitives so tabs can put them in effect deps without
	// the fresh-object-every-render infinite-loop trap (see core-client memory).
	const value = useMemo<CoreContextValue>(
		() => ({
			url: target.url,
			token: target.token,
			target,
			setTarget,
		}),
		[target]
	);
	return <CoreContext.Provider value={value}>{children}</CoreContext.Provider>;
}

/** Read the active Core node. Throws if used outside CoreProvider. */
export function useCore(): CoreContextValue {
	const ctx = useContext(CoreContext);
	if (!ctx) {
		throw new Error("useCore must be used within a CoreProvider");
	}
	return ctx;
}
