import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	useIsMutating,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { useState } from "react";
import { sileo } from "sileo";
import { useTabSelector } from "@/src/contexts/TabsContext.tsx";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import type { ModelFormat } from "@/src/lib/api/models.ts";
import {
	getActiveModel,
	getNodeEngines,
	setActiveModel,
} from "@/src/lib/api/models.ts";
import {
	resolveModelEngine,
	waitForModelEngineInstall,
} from "@/src/lib/model-engine.ts";
import { fetchCatalog, installSidecar } from "@/src/lib/services-api.ts";

const ACTIVE_MODEL_QUERY = "models";

/**
 * The primary action for an installed model. For chat models it prepares the
 * node's compatible engine when necessary, switches the served model, and opens
 * a fresh Ryu chat with that model selected. Other local model types retain the
 * existing select-as-active behavior.
 */
export function ActiveModelControl({
	repoId,
	format = "gguf",
	modelName = repoId,
	chatCapable = true,
}: {
	chatCapable?: boolean;
	format?: ModelFormat;
	modelName?: string;
	repoId: string;
}) {
	const tl = useLiteralMessages();
	const node = useActiveNode();
	const target: ApiTarget = {
		url: node.url,
		token: node.token,
		userJwt: node.userJwt ?? null,
	};
	const queryClient = useQueryClient();
	const openTab = useTabSelector((state) => state.openTab);
	const [setupStage, setSetupStage] = useState<string | null>(null);
	const [refreshFailed, setRefreshFailed] = useState(false);

	const activeQuery = useQuery({
		queryKey: [ACTIVE_MODEL_QUERY, "active", target.url],
		queryFn: () => getActiveModel(target),
	});

	const engineOptionsQueryKey = ["models", "engine-setup", target.url] as const;
	const fetchEngineOptions = async () => {
		const [nodeEngines, catalog] = await Promise.all([
			getNodeEngines(target),
			fetchCatalog(target.url, target.token, undefined, target.userJwt ?? null),
		]);
		return {
			nodeEngines,
			catalog: catalog.filter((engine) => engine.category === "provider"),
		};
	};
	const engineOptionsQuery = useQuery({
		queryKey: engineOptionsQueryKey,
		queryFn: fetchEngineOptions,
		staleTime: 30_000,
		enabled: chatCapable,
		refetchInterval: (query) => {
			const data = query.state.data;
			if (!data) {
				return false;
			}
			return resolveModelEngine(format, data.nodeEngines, data.catalog)
				?.installState === "installing"
				? 2000
				: false;
		},
	});

	const activeModel = activeQuery.data;
	const activeModelId = activeModel?.ref ?? activeModel?.active ?? null;
	const isActive =
		activeModel?.repoId === repoId ||
		activeModel?.ref === repoId ||
		activeModel?.active === repoId;
	const engineChoice = engineOptionsQuery.data
		? resolveModelEngine(
				format,
				engineOptionsQuery.data.nodeEngines,
				engineOptionsQuery.data.catalog
			)
		: null;
	const setupPending =
		useIsMutating({
			mutationKey: ["model-setup", target.url],
		}) > 0;

	const openChat = (modelId: string) => {
		queryClient
			.invalidateQueries({ queryKey: ["engine-models", target.url] })
			.catch(() => undefined);
		openTab("/chat", {
			forceNew: true,
			initialAgent: "ryu",
			initialModel: modelId,
			title: `Chat · ${modelName}`,
		});
	};

	const setupMutation = useMutation({
		mutationKey: ["model-setup", target.url],
		mutationFn: async () => {
			const options =
				engineOptionsQuery.data ??
				(await queryClient.fetchQuery({
					queryKey: engineOptionsQueryKey,
					queryFn: fetchEngineOptions,
					staleTime: 0,
				}));
			if (!options) {
				throw new Error("Could not load this node's local engines.");
			}
			const engine = resolveModelEngine(
				format,
				options.nodeEngines,
				options.catalog
			);
			if (!engine) {
				throw new Error(
					"No compatible local engine is available for this model."
				);
			}
			if (engine.installState === "installing") {
				throw new Error(
					`${engine.displayName} is already installing. Try again when it finishes.`
				);
			}

			if (engine.installState !== "installed") {
				setSetupStage(`Installing ${engine.displayName}…`);
				await installSidecar(
					target.url,
					target.token,
					engine.name,
					false,
					undefined,
					target.userJwt ?? null
				);
				await waitForModelEngineInstall(engine, async () => {
					const catalog = await fetchCatalog(
						target.url,
						target.token,
						undefined,
						target.userJwt ?? null
					);
					const installedEngine = catalog.find(
						(item) => item.name === engine.name
					);
					if (!installedEngine) {
						throw new Error(
							`${engine.displayName} is no longer available on this node.`
						);
					}
					return installedEngine.installState;
				});
			}

			setSetupStage(`Starting ${modelName}…`);
			return setActiveModel(target, repoId, engine.name);
		},
		onSuccess: async (result) => {
			await Promise.all([
				queryClient.invalidateQueries({
					queryKey: [ACTIVE_MODEL_QUERY, "active", target.url],
				}),
				queryClient.invalidateQueries({
					queryKey: ["engine-models", target.url],
				}),
				queryClient.invalidateQueries({ queryKey: engineOptionsQueryKey }),
			]);

			if (!result.gatewayRefreshed) {
				setRefreshFailed(true);
				sileo.error({
					title: "Model is active, but chat is not ready",
					description:
						"Core could not refresh the local chat route. Retry setup to reconnect it.",
				});
				return;
			}

			setRefreshFailed(false);
			sileo.success({
				title: tl("{modelName} is ready in chat", { modelName }),
			});
			openChat(result.active);
		},
		onError: (error) => {
			queryClient
				.invalidateQueries({ queryKey: engineOptionsQueryKey })
				.catch(() => undefined);
			sileo.error({
				title: "Could not start this model",
				description:
					error instanceof Error
						? error.message
						: "Check the local engine and try again.",
			});
		},
		onSettled: () => setSetupStage(null),
	});

	const switchMutation = useMutation({
		mutationFn: () => setActiveModel(target, repoId),
		onSuccess: (result) => {
			if (result.gatewayRefreshed) {
				const engine = result.engine;
				sileo.success({
					title:
						engine === null || engine === undefined
							? "Now serving this model on the local engine"
							: tl("Now serving this model on {engine}", { engine }),
				});
			} else {
				sileo.error({
					title: "Model is selected, but the local route did not refresh",
				});
			}
			Promise.resolve(
				queryClient.invalidateQueries({
					queryKey: [ACTIVE_MODEL_QUERY, "active", target.url],
				})
			).catch(() => undefined);
		},
		onError: (error) => {
			sileo.error({
				title:
					error instanceof Error ? error.message : "Failed to switch model",
			});
		},
	});

	if (!chatCapable) {
		const label = switchMutation.isPending
			? "Switching…"
			: isActive
				? "In use"
				: "Use this model";
		return (
			<Button
				disabled={isActive || activeQuery.isPending || switchMutation.isPending}
				onClick={() => switchMutation.mutate()}
				size="sm"
				type="button"
				variant={isActive ? "secondary" : "default"}
			>
				{label}
			</Button>
		);
	}

	const unavailable = !(
		engineOptionsQuery.isPending ||
		engineOptionsQuery.error ||
		engineChoice
	);
	const engineInstalling = engineChoice?.installState === "installing";
	const disabled =
		activeQuery.isPending ||
		setupMutation.isPending ||
		setupPending ||
		engineOptionsQuery.isPending ||
		Boolean(engineInstalling) ||
		unavailable;

	let label =
		engineChoice?.installState === "failed" ? "Retry setup" : "Use & chat";
	if (setupMutation.isPending) {
		label = setupStage ?? "Preparing model…";
	} else if (setupPending) {
		label = "Preparing another model…";
	} else if (engineOptionsQuery.isPending || activeQuery.isPending) {
		label = "Checking setup…";
	} else if (unavailable) {
		label = "Engine unavailable";
	} else if (engineInstalling) {
		label = `Installing ${engineChoice.displayName}…`;
	} else if (refreshFailed) {
		label = "Retry setup";
	} else if (isActive) {
		label = "Chat with this model";
	} else if (engineChoice?.installState !== "installed") {
		label = "Set up & chat";
	}

	let helper = "Ryu will open a new chat with this model selected.";
	if (engineOptionsQuery.error) {
		helper = "Could not check this node's engines. Try setup again.";
	} else if (engineChoice?.installState === "installed") {
		helper = `Ready on ${engineChoice.displayName}.`;
	} else if (engineChoice?.installState === "installing") {
		helper = `${engineChoice.displayName} is already installing on this node.`;
	} else if (engineChoice) {
		helper = `${engineChoice.displayName} will be installed if this node needs it.`;
	} else if (unavailable) {
		helper = "This node has no compatible local engine for this model format.";
	}

	return (
		<div className="flex shrink-0 flex-col items-end gap-1">
			<Button
				disabled={disabled}
				loading={setupMutation.isPending}
				onClick={() => {
					if (isActive && !refreshFailed) {
						openChat(activeModelId ?? repoId);
						return;
					}
					setupMutation.mutate();
				}}
				size="sm"
				type="button"
			>
				{label}
			</Button>
			<p className="max-w-64 text-right text-muted-foreground text-xs">
				{helper}
			</p>
		</div>
	);
}
