// apps/desktop/src/contexts/SystemStatusContext.tsx
//
// Shared context for the single polling instance of useSystemStatus. Placing the
// hook here means the shell banner, the sidebar indicator, and the chat composer
// all read from the same poll tick — no disagreement between components and no
// duplicate timers.

import { createContext, type ReactNode, useContext } from "react";
import {
	type SystemStatus,
	useSystemStatus,
} from "@/src/hooks/useSystemStatus.ts";

const SystemStatusContext = createContext<SystemStatus | null>(null);

export function SystemStatusProvider({ children }: { children: ReactNode }) {
	const status = useSystemStatus();
	return <SystemStatusContext value={status}>{children}</SystemStatusContext>;
}

/**
 * Consume the shared system status. Must be used inside `SystemStatusProvider`.
 * Throws when called outside the provider so wiring errors surface immediately.
 */
export function useSystemStatusContext(): SystemStatus {
	const ctx = useContext(SystemStatusContext);
	if (ctx === null) {
		throw new Error(
			"useSystemStatusContext must be used inside SystemStatusProvider"
		);
	}
	return ctx;
}
