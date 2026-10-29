import { createRoot } from "react-dom/client";
import { ApiSection } from "../../src/components/gateway/ApiSection.tsx";
import "../../src/index.css";

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(
		<main className="min-h-screen bg-background px-5 py-8 text-foreground sm:px-10">
			<div className="mx-auto max-w-4xl space-y-5">
				<header className="space-y-1">
					<p className="text-muted-foreground text-xs uppercase tracking-(--tracking-section)">
						Gateway · API &amp; traffic
					</p>
					<h1 className="font-semibold text-2xl">Gateway clients</h1>
				</header>
				<ApiSection
					managed={false}
					reachable
					statusUrl="http://127.0.0.1:7981"
					target={{ url: "http://127.0.0.1:7980", token: null, userJwt: null }}
				/>
			</div>
		</main>
	);
}
