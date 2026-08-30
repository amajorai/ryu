import { Button } from "@ryu/ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ryu/ui/components/dialog";
import { TextSwap } from "@ryu/ui/components/text-swap";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { sileo } from "sileo";
import { useSkillDistributionFlow } from "@/src/components/skills/SkillDistributionProvider.tsx";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	fetchModelDetail,
	installModelFile,
	type ModelDetail,
	type SetActiveModelResult,
	setActiveModel,
} from "@/src/lib/api/models.ts";
import {
	type AppInfo,
	fetchApps,
	fetchPluginCatalogDetail,
	installApp,
	type PluginCatalogDetail,
} from "@/src/lib/api/plugins.ts";
import { fetchSkillDetail, type SkillDetail } from "@/src/lib/api/skills.ts";
import { pickRecommendedQuant } from "@/src/lib/deep-link.ts";
import { useDeepLinkStore } from "@/src/store/useDeepLinkStore.ts";
import { useNodeStore } from "@/src/store/useNodeStore.ts";

interface DialogBody {
	confirm?: string;
	description: string;
	error?: boolean;
	onConfirm?: () => void;
	title: string;
}

interface DetailQuery<T> {
	data: T | undefined;
	error: unknown;
	isLoading: boolean;
}

/** Honest switch-result wording: the served-model override only affects
 * llama.cpp, so only claim "Now serving" when that engine actually reloaded. */
function switchTitle(name: string, res: SetActiveModelResult): string {
	if (res.restarted && res.engine === "llamacpp") {
		return `Now serving ${name}`;
	}
	if (res.engine && res.engine !== "llamacpp") {
		return `${name} selected (applies when llama.cpp is the active engine)`;
	}
	return `${name} selected (takes effect on next engine start)`;
}

/** The dialog content for a model intent, derived from the detail query state. */
function modelBody(
	intent: { id: string },
	q: DetailQuery<ModelDetail>,
	run: () => void
): DialogBody {
	if (q.isLoading) {
		return { title: "Loading model…", description: intent.id };
	}
	if (q.error || !q.data) {
		return {
			title: "Model not found",
			description: `Could not load "${intent.id}".`,
			error: true,
		};
	}
	const { card, files } = q.data;
	if (card.installed) {
		return {
			title: `Switch to ${card.name}?`,
			description: `${card.name} is installed. Switch the local engine to serve it now?`,
			confirm: "Switch",
			onConfirm: run,
		};
	}
	const quant = pickRecommendedQuant(files);
	if (!quant) {
		return {
			title: `Install ${card.name}?`,
			description: "This model has no downloadable GGUF file.",
			error: true,
		};
	}
	const fit = quant.fitLabel ? ` · ${quant.fitLabel}` : "";
	return {
		title: `Install ${card.name}?`,
		description: `Download ${quant.filename} (${quant.sizeHuman}${fit}) and use it as the active model.`,
		confirm: "Install & use",
		onConfirm: run,
	};
}

/** The dialog content for a skill intent. */
function skillBody(
	intent: { id: string },
	q: DetailQuery<SkillDetail>,
	run: () => void
): DialogBody {
	if (q.isLoading) {
		return { title: "Loading skill…", description: intent.id };
	}
	if (q.error || !q.data) {
		return {
			title: "Skill not found",
			description: `Could not load "${intent.id}".`,
			error: true,
		};
	}
	const { card, description } = q.data;
	if (card.installed) {
		return {
			title: `${card.name} is installed`,
			description: "This skill is already installed.",
		};
	}
	return {
		title: `Install ${card.name}?`,
		description: description ?? `Install the ${card.name} skill.`,
		confirm: "Install",
		onConfirm: run,
	};
}

/** The dialog content for an app intent. Installed state comes from `/api/apps`
 *  (the lifecycle record) rather than the catalog detail, which carries no
 *  installed flag. */
function appBody(
	intent: { id: string },
	q: DetailQuery<PluginCatalogDetail>,
	installed: AppInfo | undefined,
	run: () => void
): DialogBody {
	if (q.isLoading) {
		return { title: "Loading app…", description: intent.id };
	}
	const name = q.data?.name ?? installed?.name ?? intent.id;
	if (installed?.installed) {
		return {
			title: `${name} is installed`,
			description: "This app is already installed.",
		};
	}
	if (q.error || !q.data) {
		return {
			title: "App not found",
			description: `Could not load "${intent.id}".`,
			error: true,
		};
	}
	return {
		title: `Install ${name}?`,
		description: q.data.description ?? `Install the ${name} app.`,
		confirm: "Install",
		onConfirm: run,
	};
}

const HTTP_PREFIX = /^https?:\/\//;
const TRAILING_SLASH = /\/$/;

/** Compare two node base URLs ignoring a trailing slash. */
function sameUrl(a: string, b: string): boolean {
	return a.replace(TRAILING_SLASH, "") === b.replace(TRAILING_SLASH, "");
}

/** The dialog content for a node-connect intent. */
function nodeBody(
	intent: { name: string; url: string; token: string | null },
	alreadyKnown: boolean,
	run: () => void
): DialogBody {
	const host = intent.url.replace(HTTP_PREFIX, "");
	if (alreadyKnown) {
		return {
			title: `Switch to ${intent.name}?`,
			description: `${host} is already a saved node. Make it the active node?`,
			confirm: "Switch",
			onConfirm: run,
		};
	}
	const auth = intent.token ? " (authenticated)" : "";
	return {
		title: `Connect to ${intent.name}?`,
		description: `Add ${host}${auth} as a node and make it active. Only connect to nodes you trust.`,
		confirm: "Connect",
		onConfirm: run,
	};
}

// Confirmation surface for an inbound `ryu://` deep link. This dialog is the
// security boundary: a link from any website can request an install/switch, but
// nothing happens until the user confirms here. Installs go through Core's
// verified, source-pinned download path — the link never picks the registry.
export function DeepLinkConfirmDialog() {
	const { installCatalogSkill } = useSkillDistributionFlow();
	const pending = useDeepLinkStore((s) => s.pending);
	const clear = useDeepLinkStore((s) => s.clear);
	const qc = useQueryClient();
	const activeNode = useActiveNode();
	const nodes = useNodeStore((s) => s.nodes);
	const addNode = useNodeStore((s) => s.addNode);
	const setDefaultNode = useNodeStore((s) => s.setDefault);
	const [busy, setBusy] = useState(false);

	const intent = pending?.intent ?? null;
	const open = intent !== null;

	// A `node=` hint on an install link is ADVISORY (see @ryuhq/protocol's security
	// note): resolve it against nodes the user ALREADY has and fall back to the
	// active node when it matches none. A link can aim an install at one of your
	// nodes; it can never introduce a node, and it can never reach a host you have
	// not already saved.
	const hintedUrl =
		intent?.kind === "model" ||
		intent?.kind === "skill" ||
		intent?.kind === "app"
			? intent.node
			: null;
	const hintedNode = hintedUrl
		? nodes.find((n) => sameUrl(n.url, hintedUrl))
		: undefined;
	const installNode = hintedNode ?? activeNode;
	const target: ApiTarget = {
		url: installNode.url,
		token: installNode.token ?? null,
		userJwt: installNode.userJwt ?? null,
	};
	// True when the link named a node we do not have — say so rather than
	// silently installing somewhere the user did not pick.
	const hintUnresolved = Boolean(hintedUrl) && hintedNode === undefined;
	const modelId = intent?.kind === "model" ? intent.id : undefined;
	const skillId = intent?.kind === "skill" ? intent.id : undefined;

	const modelDetail = useQuery({
		queryKey: ["deeplink", "model", target.url, pending?.nonce, modelId],
		queryFn: () => fetchModelDetail(target, modelId ?? ""),
		enabled: open && modelId !== undefined,
	});

	const skillDetail = useQuery({
		queryKey: ["deeplink", "skill", target.url, pending?.nonce, skillId],
		queryFn: () => fetchSkillDetail(target, skillId ?? ""),
		enabled: open && skillId !== undefined,
	});

	const appId = intent?.kind === "app" ? intent.id : undefined;
	const appDetail = useQuery({
		queryKey: ["deeplink", "app", "detail", target.url, pending?.nonce, appId],
		queryFn: () => fetchPluginCatalogDetail(target, appId as string),
		enabled: open && appId !== undefined,
	});

	const installedApps = useQuery({
		queryKey: ["deeplink", "app", "installed", target.url, pending?.nonce],
		queryFn: () => fetchApps(target),
		enabled: open && appId !== undefined,
	});
	const installedApp = appId
		? installedApps.data?.find((a) => a.id === appId)
		: undefined;

	const close = () => {
		if (busy) {
			return;
		}
		clear();
	};

	async function runModel() {
		if (intent?.kind !== "model" || !modelDetail.data) {
			return;
		}
		const { card, files } = modelDetail.data;
		setBusy(true);
		try {
			if (card.installed) {
				const res = await setActiveModel(target, intent.id);
				sileo.success({ title: switchTitle(card.name, res) });
			} else {
				const quant = pickRecommendedQuant(files);
				if (!quant) {
					throw new Error("No downloadable file found for this model");
				}
				await installModelFile(target, intent.id, quant.filename);
				// The user clicked a model link to *use* it — switch as well so the
				// freshly installed weights become the served model. Best-effort:
				// the install already succeeded, so a switch hiccup isn't fatal.
				const res = await setActiveModel(target, intent.id).catch(() => null);
				sileo.success({
					title: res
						? `Installed — ${switchTitle(card.name, res).toLowerCase()}`
						: `Installed ${card.name}`,
				});
			}
			Promise.resolve(qc.invalidateQueries({ queryKey: ["models"] })).catch(
				() => undefined
			);
			clear();
		} catch (e) {
			sileo.error({
				title: e instanceof Error ? e.message : "Action failed",
			});
		} finally {
			setBusy(false);
		}
	}

	async function runSkill() {
		if (intent?.kind !== "skill" || !skillDetail.data) {
			return;
		}
		const { card } = skillDetail.data;
		setBusy(true);
		try {
			const installed = await installCatalogSkill({ id: intent.id, target });
			if (installed === null) {
				return;
			}
			sileo.success({ title: `Installed ${card.name}` });
			Promise.resolve(qc.invalidateQueries({ queryKey: ["skills"] })).catch(
				() => undefined
			);
			clear();
		} catch (e) {
			sileo.error({
				title: e instanceof Error ? e.message : "Install failed",
			});
		} finally {
			setBusy(false);
		}
	}

	async function runApp() {
		if (intent?.kind !== "app") {
			return;
		}
		const name = appDetail.data?.name ?? installedApp?.name ?? intent.id;
		setBusy(true);
		try {
			await installApp(target, intent.id);
			sileo.success({ title: `Installed ${name}` });
			Promise.resolve(qc.invalidateQueries({ queryKey: ["apps"] })).catch(
				() => undefined
			);
			clear();
		} catch (e) {
			sileo.error({
				title: e instanceof Error ? e.message : "Install failed",
			});
		} finally {
			setBusy(false);
		}
	}

	const existingNode =
		intent?.kind === "node"
			? nodes.find((n) => sameUrl(n.url, intent.url))
			: undefined;

	async function runNode() {
		if (intent?.kind !== "node") {
			return;
		}
		setBusy(true);
		try {
			if (existingNode) {
				await setDefaultNode(existingNode.name);
				sileo.success({ title: `Switched to ${existingNode.name}` });
			} else {
				// Avoid a name clash with an unrelated saved node (Core rejects dupes).
				const taken = new Set(nodes.map((n) => n.name));
				let name = intent.name;
				for (let i = 2; taken.has(name); i++) {
					name = `${intent.name}-${i}`;
				}
				await addNode(name, intent.url, intent.token ?? undefined);
				await setDefaultNode(name);
				sileo.success({ title: `Connected to ${name}` });
			}
			clear();
		} catch (e) {
			sileo.error({
				title: e instanceof Error ? e.message : "Could not connect",
			});
		} finally {
			setBusy(false);
		}
	}

	let body: DialogBody | null = null;
	if (intent?.kind === "model") {
		body = modelBody(intent, modelDetail, runModel);
	} else if (intent?.kind === "skill") {
		body = skillBody(intent, skillDetail, runSkill);
	} else if (intent?.kind === "app") {
		body = appBody(intent, appDetail, installedApp, runApp);
	} else if (intent?.kind === "node") {
		body = nodeBody(intent, existingNode !== undefined, runNode);
	}

	if (!(open && body)) {
		return null;
	}

	return (
		<Dialog onOpenChange={(o) => (o ? undefined : close())} open={open}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>{body.title}</DialogTitle>
					<DialogDescription>{body.description}</DialogDescription>
				</DialogHeader>
				{intent.kind === "model" ||
				intent.kind === "skill" ||
				intent.kind === "app" ? (
					<p className="text-muted-foreground text-xs">
						Installing on{" "}
						<span className="font-medium text-foreground">
							{installNode.name}
						</span>
						{hintUnresolved
							? " — the link named a node you have not added, so your active node is used."
							: ""}
					</p>
				) : null}
				<DialogFooter>
					<Button disabled={busy} onClick={close} type="button" variant="ghost">
						{body.confirm ? "Cancel" : "Close"}
					</Button>
					{body.confirm ? (
						<Button disabled={busy} onClick={body.onConfirm} type="button">
							<TextSwap>{busy ? "Working…" : body.confirm}</TextSwap>
						</Button>
					) : null}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
