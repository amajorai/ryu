import { Toaster } from "@ryu/ui/components/sileo.tsx";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useMemo } from "react";
import { createRoot } from "react-dom/client";
import { WorkspaceSection } from "../../src/components/gateway/WorkspaceSection.tsx";
import { installGatewayWorkspaceFetch } from "./gateway-workspace-members-proof.mock.tsx";
import "../../src/index.css";

installGatewayWorkspaceFetch();

function ProofShell() {
	const queryClient = useMemo(
		() =>
			new QueryClient({
				defaultOptions: {
					queries: { refetchOnWindowFocus: false, retry: false },
				},
			}),
		[]
	);

	return (
		<QueryClientProvider client={queryClient}>
			<div className="dark min-h-screen bg-background px-8 py-8 text-foreground">
				<main className="mx-auto max-w-5xl space-y-6">
					<header>
						<p className="text-primary text-xs tracking-(--tracking-section)">
							RYU · GATEWAY SETTINGS
						</p>
						<h1 className="mt-2 font-semibold text-3xl">Team & workspace</h1>
						<p className="mt-2 max-w-2xl text-muted-foreground text-sm">
							Rendered production Workspace settings backed by stateful
							organization, member, role, assignment, permission, and team
							fixtures.
						</p>
					</header>
					<WorkspaceSection />
				</main>
				<Toaster position="bottom-right" theme="dark" />
			</div>
		</QueryClientProvider>
	);
}

const root = document.getElementById("root");
if (!root) {
	throw new Error("Missing proof root.");
}

createRoot(root).render(<ProofShell />);
