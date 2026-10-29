import { ContextPill } from "@ryu/blocks/island/context-pill.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import type {} from "../../../island/src/preload/island.d.ts";
import { SidecarStatus } from "../../../island/src/renderer/components/SidecarStatus.tsx";
import { useActiveContext } from "../../../island/src/renderer/hooks/use-active-context.ts";
import type { ConsentState } from "../../../island/src/shared/ipc.ts";
import { InboxLink } from "../../../web/src/components/inbox-link.tsx";
import { NodeList } from "../../../web/src/components/nodes/node-list.tsx";
import "../../../web/src/index.css";

const listeners = new Set<(state: ConsentState) => void>();
let consent: ConsentState = { chat: true, contextRead: true, proactive: false };
const read = async (kind: string) => (await fetch(`/proof/${kind}`)).json();
Object.assign(window, {
	island: {
		core: {
			health: () => read("health"),
			sidecarStatus: () => read("sidecars"),
			sidecarStart: () => read("start"),
		},
		shadow: {
			getCaptureControl: () => read("control"),
			getCurrentContext: () => read("context"),
			setCaptureControl: () => read("pause"),
		},
		consent: {
			get: async () => consent,
			onChanged: (listener: (state: ConsentState) => void) => {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
		},
	},
});
function LiveContext() {
	const context = useActiveContext();
	return <ContextPill context={context} />;
}
function App() {
	const [allowed, setAllowed] = useState(true);
	const [mounted, setMounted] = useState(true);
	return (
		<main className="mx-auto max-w-4xl space-y-8 p-8">
			<header className="flex items-center justify-between">
				<div>
					<h1 className="font-heading text-2xl">Workspace status</h1>
					<p className="text-muted-foreground">
						Web and Island controls · controlled API proof
					</p>
				</div>
				{mounted && <InboxLink />}
			</header>
			<div className="flex gap-2">
				<Button
					onClick={() => {
						consent = { ...consent, contextRead: !allowed };
						setAllowed(!allowed);
						for (const listener of listeners) {
							listener(consent);
						}
					}}
				>
					{allowed ? "Pause context" : "Resume context"}
				</Button>
				<Button
					onClick={() => window.dispatchEvent(new Event("ryu:inbox-changed"))}
				>
					Refresh inbox
				</Button>
				<Button onClick={() => setMounted(!mounted)}>
					{mounted ? "Close views" : "Open views"}
				</Button>
			</div>
			{mounted && (
				<>
					<section className="rounded-xl border p-5">
						<h2 className="mb-4 font-medium text-lg">Servers</h2>
						<NodeList />
					</section>
					<section className="space-y-4 rounded-xl border p-5">
						<h2 className="font-medium text-lg">Island</h2>
						<LiveContext />
						<SidecarStatus contextReadAllowed={allowed} />
					</section>
				</>
			)}
		</main>
	);
}
createRoot(document.getElementById("root")!).render(<App />);
