import { ExtensionHost } from "@ryu/app-host/ExtensionHost";
import { capabilitiesFromGrants, type HostServices } from "@ryu/app-host/rpc";
import { htmlCompanionSrcdoc } from "@ryu/app-host/third-party-plugin";
import { Button } from "@ryu/ui/components/button.tsx";
import { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { z } from "zod";
import { pluginHostInvokeStream } from "../../src/lib/api/plugins.ts";
import "../../src/index.css";
const hostStreamProof = new URLSearchParams(location.search).has("hostStream");
const granted = capabilitiesFromGrants([
	"warmup:crud",
	"app:http",
	...(hostStreamProof ? ["hook:run-agent"] : []),
]);
function App() {
	const [html, setHtml] = useState("");
	const [mounted, setMounted] = useState(true);
	const [version, setVersion] = useState(1);
	const [theme, setTheme] = useState(false);
	const [connections, setConnections] = useState(0);
	const [reads, setReads] = useState(0);
	useEffect(() => {
		void fetch("/proof-warmup.html")
			.then((r) => r.text())
			.then(setHtml);
	}, []);
	const timingRef = useRef({
		version: 0,
		startedAt: 0,
		wrapperMs: 0,
		handshakeMs: 0,
	});
	const [samples, setSamples] = useState<
		Array<{
			version: number;
			wrapperMs: number;
			handshakeMs: number;
			readyMs: number;
		}>
	>([]);
	const srcdoc = useMemo(() => {
		const startedAt = performance.timeOrigin + performance.now();
		const pendingRead = new URLSearchParams(location.search).has("pendingRead")
			? `window.ryu.app.request({path:"/status"}).catch(()=>{});`
			: "";
		const streamScript = hostStreamProof
			? `const status=document.createElement("p");status.id="host-stream-result";status.style.cssText="padding:16px 56px 0;font-weight:600";document.body.prepend(status);window.ryu.agent.runStream({task:"Fixture only"},{onChunk:(text)=>{status.textContent+=text;}}).then(()=>{status.textContent="Stream complete: "+status.textContent;}).catch((error)=>{status.textContent=String(error);});`
			: "";
		const readyScript = `<script>const observer=new MutationObserver(()=>{if(!document.getElementById("warmup-prompt"))return;observer.disconnect();${pendingRead}${streamScript}requestAnimationFrame(()=>requestAnimationFrame(()=>parent.postMessage({kind:"proof-mounted",version:${version},readyAt:performance.timeOrigin+performance.now()},"*")))});observer.observe(document,{childList:true,subtree:true});</script>`;
		const document = htmlCompanionSrcdoc(
			"stable-test-nonce",
			html.replace(
				"<head>",
				`<head><meta name="mount-version" content="${version}">${readyScript}`
			),
			"@ryu/warmup"
		);
		timingRef.current = {
			version,
			startedAt,
			wrapperMs: performance.timeOrigin + performance.now() - startedAt,
			handshakeMs: 0,
		};
		return document;
	}, [html, version]);

	const services: HostServices = {
		runAgentStream: (input, onChunk, signal) =>
			pluginHostInvokeStream(
				{ url: location.origin, token: null },
				"@ryu/warmup",
				input,
				{ onChunk, signal }
			),
		appRequest: async (_input, signal) => {
			const response = await fetch("/proof-pending-read", { signal });
			return await response.json();
		},
		listAgents: async () => [],
		registerRoute: async (claim) => ({ path: claim.path }),
		warmupDetect: async () => {
			setReads((n) => n + 1);
			return {
				tz: "UTC",
				agents: [
					{
						id: "sample",
						name: "Codex",
						available: true,
						plan: "Subscription",
						reason: null,
						models: [],
						windows: [],
					},
				],
			};
		},
		warmupList: async () => {
			setReads((n) => n + 1);
			return [];
		},
	};
	return (
		<main className="mx-auto max-w-4xl p-8">
			<h1 className="mb-5 font-semibold text-2xl">Companion mounting</h1>
			<div className="mb-5 flex items-center gap-3">
				<Button onClick={() => setVersion((n) => n + 1)}>
					Replace document
				</Button>
				<Button onClick={() => setTheme(!theme)}>Update appearance</Button>
				<Button onClick={() => setMounted(!mounted)}>
					{mounted ? "Close companion" : "Open companion"}
				</Button>
				<span data-testid="connections">{connections}</span>
				<span data-testid="reads">{reads}</span>
			</div>
			<output className="sr-only" data-testid="mount-timings">
				{JSON.stringify(samples)}
			</output>
			<div className="h-[700px] rounded-xl border">
				{html && mounted && (
					<ExtensionHost
						granted={granted}
						nonce="stable-test-nonce"
						onConnected={() => {
							timingRef.current.handshakeMs =
								performance.timeOrigin +
								performance.now() -
								timingRef.current.startedAt;
							setConnections((n) => n + 1);
						}}
						onMessage={(value) => {
							const observation = z
								.object({
									kind: z.literal("proof-mounted"),
									version: z.number(),
									readyAt: z.number(),
								})
								.safeParse(value);
							if (
								!observation.success ||
								observation.data.version !== timingRef.current.version
							) {
								return;
							}
							const data = observation.data;
							const timing = timingRef.current;
							// SAFETY: The authored companion readyScript posts performance.timeOrigin + performance.now() as readyAt; the preceding native number guard additionally checks the structured-cloned message field before this sample calculation.
							setSamples((previous) => [
								...previous,
								{
									version: timing.version,
									wrapperMs: timing.wrapperMs,
									handshakeMs: timing.handshakeMs,
									readyMs: data.readyAt - timing.startedAt,
								},
							]);
						}}
						services={services}
						srcdoc={srcdoc}
						themeTokens={{ "--primary": theme ? "#118844" : "#0088ff" }}
						title="Warmup companion"
					/>
				)}
			</div>
		</main>
	);
}
createRoot(document.getElementById("root")!).render(<App />);
