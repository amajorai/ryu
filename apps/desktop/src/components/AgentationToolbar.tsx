import { lazy, Suspense } from "react";

// Lazy, client-only import so the toolbar's chunk is never bundled into the
// shipped app — the dev guard below returns before it ever mounts, so Vite
// never fetches the dynamic chunk in a production build.
const Agentation = lazy(() =>
	import("agentation").then((m) => ({ default: m.Agentation }))
);

// Dev-only visual feedback toolbar. Click an element in the app, add a note, and
// the annotation syncs to the local Agentation MCP server (port 4747) so the
// coding agent can read and act on it. Hidden entirely outside development.
export function AgentationToolbar() {
	if (!import.meta.env.DEV) {
		return null;
	}
	return (
		<Suspense fallback={null}>
			<Agentation endpoint="http://localhost:4747" />
		</Suspense>
	);
}
