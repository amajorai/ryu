import { Button } from "@ryu/ui/components/button.tsx";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { AcpRuntimeSection } from "../../src/components/gateway/AcpRuntimeSection.tsx";
import "../../src/index.css";
const client = new QueryClient({
	defaultOptions: { queries: { retry: false } },
});
function Story() {
	const [second, setSecond] = useState(false);
	const [mounted, setMounted] = useState(true);
	const [token, setToken] = useState("first-fixture");
	const [userJwt, setUserJwt] = useState<string | null>(null);
	return (
		<QueryClientProvider client={client}>
			<main className="min-h-screen bg-background p-8 text-foreground">
				<div className="mb-6 flex gap-2">
					<Button onClick={() => setSecond(true)}>
						Open second settings view
					</Button>
					<Button onClick={() => setToken("second-fixture")}>
						Rotate node token
					</Button>
					<Button onClick={() => setUserJwt("identity-fixture")}>
						Rotate user identity
					</Button>
					<Button onClick={() => setMounted(false)}>
						Close both settings views
					</Button>
				</div>
				{mounted ? (
					<div className="grid gap-8">
						<AcpRuntimeSection
							canConfigure={false}
							target={{ url: location.origin, token, userJwt }}
						/>
						{second ? (
							<AcpRuntimeSection
								canConfigure={false}
								target={{ url: location.origin, token, userJwt }}
							/>
						) : null}
					</div>
				) : (
					<p>Settings views closed</p>
				)}
			</main>
		</QueryClientProvider>
	);
}
const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<Story />);
}
