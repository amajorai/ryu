import { createContext, type ReactNode, use } from "react";
import {
	type IslandComposerState,
	useIslandComposer,
} from "../hooks/use-island-composer.tsx";

const IslandComposerContext = createContext<IslandComposerState | null>(null);

export function IslandComposerProvider({ children }: { children: ReactNode }) {
	const value = useIslandComposer();
	return (
		<IslandComposerContext value={value}>{children}</IslandComposerContext>
	);
}

export function useIslandComposerContext(): IslandComposerState {
	const value = use(IslandComposerContext);
	if (!value) {
		throw new Error(
			"useIslandComposerContext must be used within IslandComposerProvider"
		);
	}
	return value;
}
