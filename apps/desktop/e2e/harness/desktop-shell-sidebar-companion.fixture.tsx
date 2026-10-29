import { useTabSelector } from "../../src/contexts/TabsContext.tsx";
export default function CompanionBoundary({
	mountContext,
}: {
	mountContext?: unknown;
}) {
	const path = useTabSelector(
		(state) => state.tabs.find((tab) => tab.id === state.activeTabId)?.path
	);
	return (
		<main className="p-8">
			<h1 className="font-semibold text-xl">Project records</h1>
			<p className="mt-2 text-muted-foreground text-sm">
				Standalone app navigation
			</p>
			<output className="mt-6 block" data-testid="navigation-path">
				{path}
			</output>
			<output className="mt-2 block" data-testid="navigation-context">
				{JSON.stringify(mountContext ?? null)}
			</output>
		</main>
	);
}
