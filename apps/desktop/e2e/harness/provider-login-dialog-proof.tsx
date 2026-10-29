import { I18nProvider } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Toaster } from "@ryu/ui/components/sileo.tsx";
import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import { ThemeProvider } from "next-themes";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ProviderLoginDialog } from "../../src/components/settings/dialogs/ProviderLoginDialog.tsx";
import { AppSurfaceProvider } from "../../src/contexts/app-surface-context.tsx";
import { useActiveNode } from "../../src/hooks/useActiveNode.ts";
import type { PiLoginEvent } from "../../src/lib/api/pi-config.ts";
import { type Node, useNodeStore } from "../../src/store/useNodeStore.ts";
import { parseProofJson } from "../fixture-json.ts";
import "../../src/index.css";

const API_BASE = "http://127.0.0.1:5357";
const PROVIDER_ID = "openai-codex";
const PROVIDER_LABEL = "OpenAI Codex";

const PROOF_NODE: Node = {
	managed: true,
	name: "provider-login-proof-node",
	orgId: "provider-login-proof-org",
	token: "provider-login-node-token-1",
	url: API_BASE,
	userJwt: null,
};

useNodeStore.setState({
	defaultNode: PROOF_NODE.name,
	nodes: [PROOF_NODE],
});

interface CapturedApiRequest {
	authorization: string | null;
	body: unknown;
	method: string;
	path: string;
}

interface CapturedTauriCall {
	args: unknown;
	command: string;
}

interface AnswerOutcome {
	accepted: boolean;
	error?: string;
	status?: number;
}

interface ProviderLoginProofSnapshot {
	abortedStreams: string[];
	requests: CapturedApiRequest[];
	streamRequests: string[];
	tauriCalls: CapturedTauriCall[];
}

interface ProviderLoginProofFixture {
	emitEvent: (sessionId: string, event: PiLoginEvent) => void;
	failNextStart: () => void;
	refreshNodeToken: (token: string) => void;
	setAnswerOutcomes: (outcomes: AnswerOutcome[]) => void;
	snapshot: () => ProviderLoginProofSnapshot;
}

declare global {
	interface Window {
		__providerLoginProof: ProviderLoginProofFixture;
	}
}

function json<FixturePayload>(body: FixturePayload, status = 200): Response {
	return new Response(JSON.stringify(body), {
		headers: { "content-type": "application/json" },
		status,
	});
}

function installProviderLoginFixture(): void {
	const calls: CapturedApiRequest[] = [];
	const tauriCalls: CapturedTauriCall[] = [];
	const streamRequests: string[] = [];
	const abortedStreams: string[] = [];
	const streamControllers = new Map<
		string,
		ReadableStreamDefaultController<Uint8Array>
	>();
	let nextSession = 0;
	let startFailures = 0;
	let answerOutcomes: AnswerOutcome[] = [];
	const state: ProviderLoginProofFixture = {
		emitEvent: (sessionId, event) => {
			const controller = streamControllers.get(sessionId);
			if (!controller) {
				throw new Error(`No open provider-login stream for ${sessionId}`);
			}
			const frame = `data: ${JSON.stringify(event)}\n\n`;
			controller.enqueue(new TextEncoder().encode(frame));
		},
		failNextStart: () => {
			startFailures += 1;
		},
		refreshNodeToken: (token) => {
			useNodeStore.setState((current) => ({
				nodes: current.nodes.map((node) =>
					node.name === PROOF_NODE.name ? { ...node, token } : node
				),
			}));
		},
		setAnswerOutcomes: (outcomes) => {
			answerOutcomes = [...outcomes];
		},
		snapshot: () => ({
			abortedStreams: structuredClone(abortedStreams),
			requests: structuredClone(calls),
			streamRequests: structuredClone(streamRequests),
			tauriCalls: structuredClone(tauriCalls),
		}),
	};
	window.__providerLoginProof = state;

	const tauriWindow = window;
	const proofTauriKernel = {
		invoke: async <Arguments,>(command: string, args?: Arguments) => {
			tauriCalls.push({ command, args: args ?? null });
			return undefined;
		},
		transformCallback: () => 1,
	};
	// SAFETY: This browser fixture installs the exact complete private kernel constructed above.
	// This mutation view owns that two-method fixture slot, not the public Tauri SDK result ABI.
	(
		tauriWindow as Omit<typeof window, "__TAURI_INTERNALS__"> & {
			__TAURI_INTERNALS__: typeof proofTauriKernel;
		}
	).__TAURI_INTERNALS__ = proofTauriKernel;

	const realFetch = window.fetch.bind(window);
	window.fetch = async (input, init) => {
		const rawUrl = input instanceof Request ? input.url : String(input);
		const url = new URL(rawUrl, window.location.href);
		if (!url.pathname.startsWith("/api/pi-config/")) {
			return realFetch(input, init);
		}

		const request = input instanceof Request ? input : null;
		const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
		const body = isNativeText(init?.body) ? parseProofJson(init.body) : null;
		const headers = new Headers(init?.headers ?? request?.headers);
		calls.push({
			authorization: headers.get("authorization"),
			body,
			method,
			path: url.pathname,
		});

		if (
			method === "POST" &&
			url.pathname === `/api/pi-config/providers/${PROVIDER_ID}/login`
		) {
			if (startFailures > 0) {
				startFailures -= 1;
				return json(
					{ error: "Provider login is temporarily unavailable." },
					503
				);
			}
			nextSession += 1;
			return json({ sessionId: `login-session-${nextSession}` });
		}

		const streamMatch = url.pathname.match(
			/^\/api\/pi-config\/login\/([^/]+)\/events$/
		);
		if (method === "GET" && streamMatch) {
			const sessionId = decodeURIComponent(streamMatch[1]);
			streamRequests.push(sessionId);
			let controllerRef: ReadableStreamDefaultController<Uint8Array> | null =
				null;
			const stream = new ReadableStream<Uint8Array>({
				start: (controller) => {
					controllerRef = controller;
					streamControllers.set(sessionId, controller);
				},
				cancel: () => {
					streamControllers.delete(sessionId);
				},
			});
			const signal = init?.signal ?? request?.signal;
			signal?.addEventListener(
				"abort",
				() => {
					abortedStreams.push(sessionId);
					try {
						controllerRef?.close();
					} catch {
						// The reader may have already closed the fixture stream.
					}
					streamControllers.delete(sessionId);
				},
				{ once: true }
			);
			return new Response(stream, {
				headers: { "content-type": "text/event-stream" },
			});
		}

		const answerMatch = url.pathname.match(
			/^\/api\/pi-config\/login\/([^/]+)\/answer$/
		);
		if (method === "POST" && answerMatch) {
			const outcome = answerOutcomes.shift() ?? { accepted: true };
			return json(
				outcome.accepted
					? { accepted: true }
					: {
							accepted: false,
							error: outcome.error ?? "The answer was rejected.",
						},
				outcome.status ?? 200
			);
		}

		const cancelMatch = url.pathname.match(
			/^\/api\/pi-config\/login\/([^/]+)\/cancel$/
		);
		if (method === "POST" && cancelMatch) {
			return json({ cancelled: true });
		}

		return json(
			{ error: `Unexpected provider login request: ${method} ${url.pathname}` },
			404
		);
	};
}

function ProviderLoginProof() {
	const activeNode = useActiveNode();
	const [open, setOpen] = useState(false);
	const [successCount, setSuccessCount] = useState(0);
	const [configured, setConfigured] = useState(false);
	return (
		<ThemeProvider
			attribute="class"
			defaultTheme="dark"
			storageKey="provider-login-dialog-proof-theme"
		>
			<I18nProvider>
				<AppSurfaceProvider surface="desktop">
					<main className="min-h-screen bg-background p-8 text-foreground">
						<div className="mx-auto flex max-w-lg flex-col gap-5">
							<header>
								<p className="text-muted-foreground text-xs uppercase tracking-wide">
									Rendered ProviderLoginDialog proof
								</p>
								<h1 className="mt-1 font-semibold text-xl">
									Provider subscription login
								</h1>
							</header>
							<Button onClick={() => setOpen(true)}>Open provider login</Button>
							<output
								data-open={String(open)}
								data-testid="provider-dialog-state"
							>
								{open ? "Login dialog open" : "Login dialog closed"}
							</output>
							<output data-testid="provider-account-state">
								{configured ? "Connected" : "Not connected"}
							</output>
							<output data-testid="provider-refresh-count">
								{successCount}
							</output>
							<output className="sr-only" data-testid="active-node-token">
								{activeNode.token ?? "none"}
							</output>
							<ProviderLoginDialog
								onOpenChange={setOpen}
								onSuccess={() => {
									setSuccessCount((count) => count + 1);
									setConfigured(true);
								}}
								open={open}
								providerId={PROVIDER_ID}
								providerLabel={PROVIDER_LABEL}
							/>
						</div>
					</main>
					<Toaster position="bottom-right" theme="dark" />
				</AppSurfaceProvider>
			</I18nProvider>
		</ThemeProvider>
	);
}

installProviderLoginFixture();
const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<ProviderLoginProof />);
}
