import { createRoot } from "react-dom/client";
import { MemoryLibrary } from "../../src/components/memory/MemoryLibrary.tsx";
import { AppSurfaceProvider } from "../../src/contexts/app-surface-context.tsx";
import type { Memory } from "../../src/lib/api/memory.ts";
import "../../src/index.css";

const memory: Memory = {
	authorAgentId: null,
	category: "directive",
	content: "Use Git history to explain durable memory changes.",
	createdAt: 1,
	id: "memory-git-proof",
	importance: 4,
	scope: "user",
	scopeId: null,
	tags: ["git", "trace"],
	updatedAt: 2,
	whenToUse: "When reviewing memory changes",
};

function json<FixturePayload>(payload: FixturePayload) {
	return Response.json(payload);
}

globalThis.fetch = async (input: URL | RequestInfo, init?: RequestInit) => {
	const url = new URL(String(input), window.location.origin);
	if (
		url.pathname === "/api/memory" &&
		(!init?.method || init.method === "GET")
	) {
		return json({ memories: [memory] });
	}
	if (url.pathname === "/api/preferences/memory.git-root") {
		return json({ key: "memory.git-root", value: "/Users/demo/memory-repo" });
	}
	if (url.pathname === "/api/git/status") {
		return json({
			ahead: 0,
			behind: 0,
			branch: "main",
			changed_files_count: 2,
			deletions: 0,
			dirty: true,
			insertions: 18,
			is_repo: true,
		});
	}
	return json({});
};

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(
		<AppSurfaceProvider surface="desktop">
			<div className="min-h-screen bg-background px-6 py-10 text-foreground">
				<MemoryLibrary />
			</div>
		</AppSurfaceProvider>
	);
}
