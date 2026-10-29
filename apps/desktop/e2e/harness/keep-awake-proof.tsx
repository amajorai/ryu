import { Button } from "@ryu/ui/components/button.tsx";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { AcpRuntimeSection } from "../../src/components/gateway/AcpRuntimeSection.tsx";
import { useAcpKeepAwake } from "../../src/hooks/useAcpKeepAwake.ts";
import { LOCAL_FALLBACK, useNodeStore } from "../../src/store/useNodeStore.ts";
import "../../src/index.css";
const client = new QueryClient({
	defaultOptions: { queries: { retry: false } },
});
const local = { ...LOCAL_FALLBACK, token: "keep-awake-fixture" };
function replace(node: typeof local) {
	useNodeStore.setState({
		localNodes: [node],
		nodes: [node],
		defaultNode: node.name,
	});
}
replace(local);
function Monitor() {
	useAcpKeepAwake();
	return null;
}
function Story() {
	const [mounted, setMounted] = useState(true);
	return (
		<QueryClientProvider client={client}>
			<main className="min-h-screen bg-background p-8 text-foreground">
				<div className="mb-6 flex gap-2">
					<Button onClick={() => replace({ ...local, name: "Renamed local" })}>
						Rename node
					</Button>
					<Button
						onClick={() => replace({ ...local, token: "rotated-fixture" })}
					>
						Rotate token
					</Button>
					<Button
						onClick={() => replace({ ...local, url: "http://remote.invalid" })}
					>
						Remote node
					</Button>
					<Button onClick={() => setMounted(false)}>Unmount monitor</Button>
				</div>
				{mounted ? <Monitor /> : null}
				<AcpRuntimeSection
					canConfigure={false}
					target={{ url: location.origin, token: null }}
				/>
			</main>
		</QueryClientProvider>
	);
}
const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<Story />);
}
