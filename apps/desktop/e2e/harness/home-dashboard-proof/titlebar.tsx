import type { ReactNode } from "react";
import { createContext, useContext, useEffect, useState } from "react";

const TitleBarActionsContext = createContext<(actions: ReactNode) => void>(
	() => undefined
);

export function HomeDashboardTitleBar({ children }: { children: ReactNode }) {
	const [actions, setActions] = useState<ReactNode>(null);
	return (
		<TitleBarActionsContext.Provider value={setActions}>
			<header
				aria-label="Dashboard title bar"
				className="flex h-[52px] items-center justify-end border-b bg-card px-4"
			>
				<div className="flex items-center gap-3" data-testid="titlebar-actions">
					{actions}
				</div>
			</header>
			{children}
		</TitleBarActionsContext.Provider>
	);
}

export function useTitleBar(_title: ReactNode, actions?: ReactNode) {
	const setActions = useContext(TitleBarActionsContext);
	useEffect(() => {
		setActions(actions ?? null);
		return () => setActions(null);
	}, [actions, setActions]);
}
