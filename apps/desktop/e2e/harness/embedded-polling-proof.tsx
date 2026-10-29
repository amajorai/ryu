import { Button } from "@ryu/ui/components/button.tsx";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "../../src/index.css";
function App() {
	const [active, setActive] = useState(true);
	const [reads, setReads] = useState(0);
	const [visibility, setVisibility] = useState("");
	useEffect(() => {
		const listener = (event: MessageEvent) => {
			const frame = document.querySelector("iframe");
			if (event.source !== frame?.contentWindow) {
				return;
			}
			if (event.data?.kind === "proof-read") {
				setReads(event.data.reads);
			}
			if (event.data?.kind === "proof-visibility") {
				setVisibility(`${event.data.visible}/${event.data.documentVisibility}`);
			}
		};
		window.addEventListener("message", listener);
		return () => window.removeEventListener("message", listener);
	}, []);
	return (
		<main className="mx-auto max-w-4xl p-8">
			<header className="mb-6 flex items-center justify-between">
				<h1 className="font-semibold text-2xl">Ryu workspace</h1>
				<span data-testid="reads">{reads}</span>
			</header>
			<div className="mb-4 flex gap-2">
				<Button
					onClick={() => setActive(true)}
					variant={active ? "default" : "outline"}
				>
					Companion
				</Button>
				<Button
					onClick={() => setActive(false)}
					variant={active ? "outline" : "default"}
				>
					Another tab
				</Button>
				<Button
					onClick={() =>
						document
							.querySelector("iframe")
							?.contentWindow?.postMessage("proof-visibility", "*")
					}
				>
					Inspect visibility
				</Button>
				<output data-testid="visibility">{visibility}</output>
			</div>
			<div className={active ? "block" : "hidden"}>
				<iframe
					className="h-[700px] w-full rounded-xl border"
					sandbox="allow-scripts"
					src="./embedded-polling-child.html"
					title="Companion workspace"
				/>
			</div>
			{!active && (
				<section className="rounded-xl border p-8">
					<h2 className="font-medium text-lg">Another tab</h2>
					<p>The companion stays mounted with its state intact.</p>
				</section>
			)}
		</main>
	);
}
createRoot(document.getElementById("root")!).render(<App />);
