"use client";

import {
	type AvatarContributions,
	EMPTY_AVATAR_CONTRIBUTIONS,
} from "@ryu/ui/components/avatar-parts.ts";
import { createContext, type ReactNode, useContext } from "react";

/* The host (desktop shell, web app) owns where plugin contributions come from;
   shared avatar renderers and editors only read them from this context. Without
   a provider every surface behaves exactly as before: built-in parts only. */
const AvatarContributionsContext = createContext<AvatarContributions>(
	EMPTY_AVATAR_CONTRIBUTIONS
);

export function AvatarContributionsProvider({
	value,
	children,
}: {
	children: ReactNode;
	value: AvatarContributions;
}) {
	return (
		<AvatarContributionsContext.Provider value={value}>
			{children}
		</AvatarContributionsContext.Provider>
	);
}

/** Accessories and styles from enabled plugins, or none outside a provider. */
export function useAvatarContributions(): AvatarContributions {
	return useContext(AvatarContributionsContext);
}
