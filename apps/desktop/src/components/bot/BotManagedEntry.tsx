import { Button } from "@ryu/ui/components/button.tsx";
import {
	Card,
	CardContent,
	CardFooter,
	CardHeader,
} from "@ryu/ui/components/card.tsx";
import { Logo } from "@ryu/ui/components/logo.tsx";
import { PageHeader } from "@ryu/ui/components/page-header.tsx";
import { Spinner } from "@ryu/ui/components/spinner.tsx";
import { useCallback, useEffect, useRef, useState } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { WEB_URL } from "@/lib/app-urls.ts";
import { openExternal } from "@/lib/tauri-bridge.ts";
import Layout from "@/src/components/layout/Layout.tsx";
import { useCreditsWallet } from "@/src/hooks/useCreditsWallet.ts";
import { toTarget } from "@/src/lib/api/client.ts";
import {
	type AgentSelection,
	getLaneAgentSelection,
	setLaneAgentSelection,
} from "@/src/lib/api/preferences.ts";
import { useNodeStore } from "@/src/store/useNodeStore.ts";
import {
	type BotManagedEntryState,
	resolveBotCloudSelection,
	resolveBotManagedEntryState,
	resolveBotManagedNode,
} from "./bot-managed-entry-state.ts";

const PROVISIONING_POLL_MS = 5000;
const SELECTION_FIELDS = [
	"agent_id",
	"provider",
	"model",
	"thinking_level",
	"effort",
	"access_mode",
] as const satisfies readonly (keyof AgentSelection)[];
function workspaceKey(node: {
	name: string;
	url: string;
	token: string | null;
	userJwt?: string | null;
}) {
	return JSON.stringify([
		node.name,
		node.url,
		node.token,
		node.userJwt ?? null,
	]);
}

function BotEntryCard({
	busy,
	error,
	onRetry,
	state,
}: {
	busy: boolean;
	error: string | null;
	onRetry: () => void;
	state: Exclude<BotManagedEntryState, "ready">;
}) {
	const subscribe = state === "subscribe";
	const checking = state === "checking-subscription";
	return (
		<Card className="w-full max-w-md">
			<CardHeader appearance="bot-entry">
				<Logo size="48px" variant="outline" />
				<PageHeader
					className="text-center"
					stagger={false}
					subtitle={
						checking
							? "Checking your Ryu subscription."
							: subscribe
								? "A Ryu subscription includes your managed Bot workspace."
								: "Ryu is preparing your managed Bot workspace."
					}
					title="Bot"
				/>
			</CardHeader>
			<CardContent inset="bot-entry">
				{error ? (
					<p
						className="text-center text-sm text-status-destructive"
						role="alert"
					>
						{error}
					</p>
				) : checking ? (
					<div className="flex items-center gap-2 text-muted-foreground text-sm">
						<Spinner /> Checking your subscription…
					</div>
				) : subscribe ? (
					<p className="max-w-sm text-center text-muted-foreground text-sm leading-relaxed">
						Subscribe once and Ryu manages the models, device, and
						infrastructure for you. There is no provider setup in Bot.
					</p>
				) : (
					<div className="flex items-center gap-2 text-muted-foreground text-sm">
						<Spinner /> Preparing your managed workspace…
					</div>
				)}
			</CardContent>
			<CardFooter
				appearance="bot-entry"
				className="justify-center"
				spacing="actions"
			>
				{subscribe ? (
					<Button
						data-testid="bot-subscribe"
						onClick={() => {
							openExternal(`${WEB_URL}/pricing`).catch(() => undefined);
						}}
					>
						Choose a subscription
					</Button>
				) : (
					<Button
						data-testid="bot-retry"
						disabled={busy}
						onClick={onRetry}
						variant="outline"
					>
						{busy ? <Spinner /> : null}
						Refresh workspace
					</Button>
				)}
			</CardFooter>
		</Card>
	);
}

/**
 * Account-only Bot entry point. It adopts the user's existing managed node and
 * ensures the shared cloud-lane default; it never provisions a node, handles a
 * credential, or changes the runtime's authorization gates from the client.
 */
export function BotManagedEntry() {
	const {
		entitlement,
		loading: resolvingSubscription,
		refresh,
	} = useCreditsWallet();
	const hydrateCloudNodes = useNodeStore((state) => state.hydrateCloudNodes);
	const managedNode = useNodeStore(resolveBotManagedNode);
	const [state, setState] = useState<BotManagedEntryState>(
		"checking-subscription"
	);
	const [busy, setBusy] = useState(false);
	const [confirmationError, setConfirmationError] = useState<string | null>(
		null
	);
	const confirmedWorkspace = useRef<string | null>(null);
	const adoptionInFlight = useRef(false);
	const adoptionGeneration = useRef(0);
	useEffect(
		() => () => {
			adoptionGeneration.current++;
		},
		[]
	);

	const adoptManagedWorkspace = useCallback(async () => {
		if (
			resolvingSubscription ||
			!entitlement?.managedInference ||
			adoptionInFlight.current
		) {
			return;
		}
		setBusy(true);
		const generation = adoptionGeneration.current;
		adoptionInFlight.current = true;
		setConfirmationError(null);
		setState("provisioning");
		try {
			await hydrateCloudNodes().catch(() => undefined);
			const node = resolveBotManagedNode(useNodeStore.getState());
			if (!node) {
				return;
			}
			const isCurrent = () => {
				const latest = resolveBotManagedNode(useNodeStore.getState());
				return (
					generation === adoptionGeneration.current &&
					latest !== undefined &&
					workspaceKey(latest) === workspaceKey(node)
				);
			};
			if (!isCurrent()) {
				return;
			}

			// Bot adopts the managed node in memory only. The Build product owns the
			// user's durable local-node list; writing a cloud node into that file would
			// make a zero-setup product mutate the power-user product's configuration.
			useNodeStore.setState((current) => ({
				defaultNode: node.name,
				nodes: current.nodes.some((candidate) => candidate.name === node.name)
					? current.nodes
					: [...current.nodes, node],
			}));
			// This is the existing shared managed provider seam. Bot does not expose a
			// picker, BYOK key, or routing toggle. Console owners/admins can configure
			// the managed node's cloud lane, so preserve that value and seed the
			// subscription's Auto cloud default only when the lane is unset.
			const target = toTarget(node);
			const currentSelection = await getLaneAgentSelection(target, "cloud");
			if (!isCurrent()) {
				return;
			}
			const resolved = resolveBotCloudSelection(currentSelection);
			if (resolved.shouldPersist) {
				const saved = await setLaneAgentSelection(
					target,
					"cloud",
					resolved.selection
				);
				const persisted = await getLaneAgentSelection(target, "cloud");
				if (!isCurrent()) {
					return;
				}
				if (
					!(
						saved &&
						SELECTION_FIELDS.every(
							(field) => persisted[field] === resolved.selection[field]
						)
					)
				) {
					throw new Error("Managed cloud selection was not persisted");
				}
			}
			confirmedWorkspace.current = workspaceKey(node);
			setState("ready");
		} catch {
			if (generation !== adoptionGeneration.current) {
				return;
			}
			setConfirmationError(
				"Couldn't confirm your managed workspace. Refresh workspace to try again."
			);
			setState("provisioning");
		} finally {
			adoptionInFlight.current = false;
			if (generation === adoptionGeneration.current) {
				setBusy(false);
			}
		}
	}, [entitlement?.managedInference, hydrateCloudNodes, resolvingSubscription]);

	useEffect(() => {
		const next = resolveBotManagedEntryState({
			hasManagedNode: managedNode !== undefined,
			managedInference: entitlement?.managedInference === true,
			resolvingSubscription,
		});
		if (next === "checking-subscription" || next === "subscribe") {
			adoptionGeneration.current++;
			setBusy(false);
			confirmedWorkspace.current = null;
			setConfirmationError(null);
			setState(next);
			return;
		}
		if (
			managedNode &&
			confirmedWorkspace.current === workspaceKey(managedNode)
		) {
			setState("ready");
			return;
		}
		setState("provisioning");
		adoptManagedWorkspace().catch(() => undefined);
	}, [
		adoptManagedWorkspace,
		entitlement?.managedInference,
		managedNode,
		resolvingSubscription,
	]);

	useEffect(() => {
		if (
			state !== "provisioning" ||
			!entitlement?.managedInference ||
			confirmationError
		) {
			return;
		}
		const timer = setInterval(() => {
			adoptManagedWorkspace().catch(() => undefined);
		}, PROVISIONING_POLL_MS);
		return () => clearInterval(timer);
	}, [
		adoptManagedWorkspace,
		confirmationError,
		entitlement?.managedInference,
		state,
	]);

	if (
		state === "ready" &&
		managedNode &&
		confirmedWorkspace.current === workspaceKey(managedNode)
	) {
		return (
			<MemoryRouter initialEntries={["/chat"]}>
				<Routes>
					<Route element={<Layout />} path="/*" />
				</Routes>
			</MemoryRouter>
		);
	}

	return (
		<div
			className="flex size-full items-center justify-center p-6"
			data-product="ryu-bot"
			data-testid="bot-managed-entry"
		>
			<BotEntryCard
				busy={busy}
				error={confirmationError}
				onRetry={() => {
					if (state === "subscribe") {
						refresh().catch(() => undefined);
						return;
					}
					adoptManagedWorkspace().catch(() => undefined);
				}}
				state={state === "ready" ? "provisioning" : state}
			/>
		</div>
	);
}
