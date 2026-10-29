import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { ComputerUseSettings } from "../../src/components/gateway/ComputerUseSettings.tsx";
import type { ApiTarget } from "../../src/lib/api/client.ts";
import type { GatewayComputerUseConfig } from "../../src/lib/api/gateway.ts";
import {
	type PluginValue,
	pluginValueSchema,
} from "../../src/lib/api/plugin-wire-values.ts";
import {
	computerUseBodyTextSchema,
	computerUseEventSchema,
	computerUseFieldsSchema,
	computerUsePatchProofSchema,
} from "../computer-use-proof.contracts.ts";
import styles from "./computer-use-settings-proof.module.css";
import "../../src/index.css";

const TARGET: ApiTarget = {
	token: null,
	url: "http://127.0.0.1:7980",
};

const PERSISTENCE_KEY = "ryu.desktop.computer-use-settings-proof";
const query = new URLSearchParams(window.location.search);

function readPersistedComputerUse(): GatewayComputerUseConfig {
	const stored = window.localStorage.getItem(PERSISTENCE_KEY);
	if (stored) {
		try {
			const parsed = computerUseFieldsSchema.safeParse(JSON.parse(stored));
			if (parsed.success) {
				return { locked_use: parsed.data.locked_use };
			}
		} catch {
			// The proof fixture starts from its default policy when saved state is invalid.
		}
	}
	return { locked_use: false };
}

let computerUse = readPersistedComputerUse();
let failNextWrite = false;
const requests: {
	body: PluginValue;
	method: string;
	path: string;
	status: number;
}[] = [];

function emitEvent(message: string): void {
	window.dispatchEvent(
		new CustomEvent("computer-use-proof-event", { detail: message })
	);
}

function installGatewayMock(): () => void {
	const nativeFetch = Object.assign(window.fetch.bind(window), {
		preconnect: window.fetch.preconnect,
	});
	window.fetch = Object.assign(
		async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = input instanceof Request ? input.url : String(input);
			const path = new URL(url).pathname;
			if (path !== "/api/gateway/config") {
				return nativeFetch(input, init);
			}

			const method = (
				init?.method ?? (input instanceof Request ? input.method : "GET")
			).toUpperCase();
			if (method === "PUT") {
				const bodyText = computerUseBodyTextSchema.safeParse(init?.body);
				const patch = computerUsePatchProofSchema.parse(
					JSON.parse(bodyText.success ? bodyText.data : "{}")
				);
				const status = failNextWrite ? 503 : 200;
				failNextWrite = false;
				requests.push({
					body: pluginValueSchema.parse(patch),
					method,
					path,
					status,
				});
				if (status === 503) {
					return new Response(
						JSON.stringify({ error: "Fixture write unavailable" }),
						{
							headers: { "content-type": "application/json" },
							status,
						}
					);
				}
				if (patch.computer_use) {
					computerUse = patch.computer_use;
					window.localStorage.setItem(
						PERSISTENCE_KEY,
						JSON.stringify(computerUse)
					);
					emitEvent(
						`Gateway saved [computer_use]: locked_use=${String(computerUse.locked_use)}`
					);
				}
				return new Response(JSON.stringify({ ok: true }), {
					headers: { "content-type": "application/json" },
					status,
				});
			}

			requests.push({ body: null, method, path, status: 200 });
			return new Response(JSON.stringify({ computer_use: computerUse }), {
				headers: { "content-type": "application/json" },
				status: 200,
			});
		},
		{ preconnect: nativeFetch.preconnect }
	);

	return () => {
		window.fetch = nativeFetch;
	};
}

const proofState = {
	failNextWrite: () => {
		failNextWrite = true;
	},
	snapshot: () => ({
		computerUse: { ...computerUse },
		requests: requests.map((request) => ({ ...request })),
	}),
};

Object.assign(window, { __COMPUTER_USE_SETTINGS_PROOF__: proofState });

function ProofArtifact() {
	const [events, setEvents] = useState([
		`Gateway policy loaded: locked use is ${computerUse.locked_use ? "on" : "off"}`,
	]);
	const queryClient = useMemo(
		() =>
			new QueryClient({
				defaultOptions: { queries: { retry: false } },
			}),
		[]
	);

	useEffect(() => {
		const onEvent = (event: Event) => {
			if (!(event instanceof CustomEvent)) {
				throw new Error(
					"Computer-use proof event must be a native CustomEvent"
				);
			}
			const detail = computerUseEventSchema.parse(event.detail);
			setEvents((current) => [...current, detail].slice(-5));
		};
		window.addEventListener("computer-use-proof-event", onEvent);
		return () => {
			window.removeEventListener("computer-use-proof-event", onEvent);
		};
	}, []);

	return (
		<QueryClientProvider client={queryClient}>
			<main className={`dark min-h-screen px-7 py-8 ${styles.surface}`}>
				<div className="mx-auto max-w-5xl">
					<header className="mb-6 flex items-start justify-between gap-5">
						<div>
							<div className={`text-xs ${styles.eyebrow}`}>
								RYU · PRODUCTION COMPONENT PROOF
							</div>
							<h1 className="mt-2 font-semibold text-3xl">Device settings</h1>
							<p
								className={`mt-2 max-w-2xl text-base leading-6 ${styles.description}`}
							>
								Gateway-owned permissions for Ghost on the selected device.
							</p>
						</div>
						<div
							className={`type-caption rounded-full border px-3 py-2 font-semibold tracking-wide ${styles.fixtureBadge}`}
						>
							LOCAL FIXTURE · STATEFUL
						</div>
					</header>

					<div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_300px]">
						<section className={`rounded-2xl border p-5 ${styles.devicePanel}`}>
							<div
								className={`mb-5 flex items-center justify-between border-b pb-4 ${styles.deviceHeader}`}
							>
								<div>
									<div
										className={`type-caption uppercase tracking-wide ${styles.deviceLabel}`}
									>
										Selected device
									</div>
									<div className="mt-1 font-medium text-lg">My MacBook</div>
								</div>
								<span
									className={`rounded-full border px-2 py-1 text-xs ${styles.onlineBadge}`}
								>
									Online
								</span>
							</div>
							<ComputerUseSettings
								canConfigure={query.get("canConfigure") !== "false"}
								reachable={query.get("reachable") !== "false"}
								target={TARGET}
							/>
						</section>

						<aside className={`rounded-2xl border p-5 ${styles.policyPanel}`}>
							<div
								className={`type-caption tracking-wide ${styles.policyLabel}`}
							>
								LOCAL GATEWAY FIXTURE
							</div>
							<h2 className="mt-2 font-medium text-xl">Device policy</h2>
							<div
								className={`mt-4 rounded-xl border p-3 font-mono text-xs leading-6 ${styles.policyCode}`}
							>
								<div>scope: selected device</div>
								<div>section: [computer_use]</div>
								<div>default: locked_use = false</div>
							</div>
							<div className={`mt-5 mb-2 text-xs ${styles.traceLabel}`}>
								Persistence trace
							</div>
							<ol
								className={`type-caption m-0 list-decimal space-y-1 pl-5 font-mono leading-5 ${styles.trace}`}
							>
								{events.map((event, index) => (
									<li key={`${event}-${index}`}>{event}</li>
								))}
							</ol>
						</aside>
					</div>
				</div>
			</main>
		</QueryClientProvider>
	);
}

installGatewayMock();
createRoot(document.getElementById("root")!).render(<ProofArtifact />);
