import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ApiSection } from "../../src/components/gateway/ApiSection.tsx";
import "../../src/index.css";

function NativeCliProof() {
	const [gatewayUrl, setGatewayUrl] = useState<string | null>(null);
	useEffect(() => {
		fetch("/__cli/meta")
			.then((response) => response.json())
			.then((value) => setGatewayUrl(value.gatewayUrl));
	}, []);
	if (!gatewayUrl) {
		return <p>Connecting to the isolated Gateway…</p>;
	}
	return (
		<main className="min-h-screen bg-background px-5 py-8 text-foreground sm:px-10">
			<div className="mx-auto max-w-4xl space-y-5">
				<h1 className="font-semibold text-2xl">Gateway clients</h1>
				<ApiSection
					managed={false}
					reachable
					statusUrl={gatewayUrl}
					target={{ url: window.location.origin, token: null, userJwt: null }}
				/>
			</div>
		</main>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<NativeCliProof />);
}
