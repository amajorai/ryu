import { fitBlockReason, isBlockedFit } from "@ryu/blocks/desktop/model-fit.ts";
import { useLiteralMessages, useRichLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ryu/ui/components/dialog.tsx";
import { TextSwap } from "@ryu/ui/components/text-swap.tsx";
import { skipToken, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { sileo } from "sileo";
import { useSkillDistributionFlow } from "@/src/components/skills/SkillDistributionProvider.tsx";
import { bundleSkillChanges } from "@/src/components/skills/skill-set-change.ts";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import { fetchDetail } from "@/src/lib/api/marketplace.ts";
import {
	describeBundleManualSteps,
	installMarketplaceBundle,
} from "@/src/lib/api/marketplace-bundles.ts";
import {
	fetchModelDetail,
	installModelFile,
	setActiveModel,
} from "@/src/lib/api/models.ts";
import {
	fetchApps,
	fetchPluginCatalogDetail,
	installApp,
} from "@/src/lib/api/plugins.ts";
import { fetchSkillDetail } from "@/src/lib/api/skills.ts";
import { pickRecommendedQuant } from "@/src/lib/deep-link.ts";
import { useDeepLinkStore } from "@/src/store/useDeepLinkStore.ts";
import { useNodeStore } from "@/src/store/useNodeStore.ts";
import {
	appBody,
	bundleBody,
	type DialogBody,
	modelBody,
	nodeBody,
	sameUrl,
	skillBody,
	switchTitle,
} from "./DeepLinkConfirmDialog-bodies.ts";

// Confirmation surface for an inbound `ryu://` deep link. This dialog is the
// security boundary: a link from any website can request an install/switch, but
// nothing happens until the user confirms here. Installs go through Core's
// verified, source-pinned download path — the link never picks the registry.
export function DeepLinkConfirmDialog() {
	const { confirmSkillSetChange, installCatalogSkill } =
		useSkillDistributionFlow();
	const pending = useDeepLinkStore((s) => s.pending);
	const clear = useDeepLinkStore((s) => s.clear);
	const qc = useQueryClient();
	const activeNode = useActiveNode();
	const nodes = useNodeStore((s) => s.nodes);
	const addNode = useNodeStore((s) => s.addNode);
	const setDefaultNode = useNodeStore((s) => s.setDefault);
	const [busy, setBusy] = useState(false);
	const tl = useLiteralMessages();
	const tlRich = useRichLiteralMessages();

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
		intent?.kind === "app" ||
		intent?.kind === "bundle"
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

	const bundleId = intent?.kind === "bundle" ? intent.id : undefined;
	const bundleDetail = useQuery({
		queryKey: ["deeplink", "bundle", target.url, pending?.nonce, bundleId],
		queryFn: () => fetchDetail("bundle", bundleId ?? ""),
		enabled: open && bundleId !== undefined,
	});

	const appId = intent?.kind === "app" ? intent.id : undefined;
	const appDetail = useQuery({
		queryKey: ["deeplink", "app", "detail", target.url, pending?.nonce, appId],
		queryFn:
			appId === null || appId === undefined
				? skipToken
				: () => fetchPluginCatalogDetail(target, appId),
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
				sileo.success({ title: switchTitle(card.name, res, tl) });
			} else {
				const quant = pickRecommendedQuant(files);
				if (!quant) {
					throw new Error("No downloadable file found for this model");
				}
				if (isBlockedFit(quant.fit)) {
					throw new Error(
						fitBlockReason(
							quant.fit,
							quant.fitLabel,
							modelDetail.data.device
						) ?? "This model won't fit on this device"
					);
				}
				await installModelFile(target, intent.id, quant.filename);
				// The user clicked a model link to *use* it — switch as well so the
				// freshly installed weights become the served model. Best-effort:
				// the install already succeeded, so a switch hiccup isn't fatal.
				const res = await setActiveModel(target, intent.id).catch(() => null);
				sileo.success({
					title: res
						? `Installed — ${switchTitle(card.name, res, tl).toLowerCase()}`
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
			const installed = await installCatalogSkill({
				id: intent.id,
				name: card.name,
				target,
			});
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

	async function runBundle() {
		if (intent?.kind !== "bundle" || !bundleDetail.data) {
			return;
		}
		setBusy(true);
		try {
			// New skill members change every skill-loading thread's prompt.
			const confirmed = await confirmSkillSetChange(
				await bundleSkillChanges(target, bundleDetail.data.bundleMembers)
			);
			if (!confirmed) {
				return;
			}
			const result = await installMarketplaceBundle(
				target,
				intent.id,
				bundleDetail.data.bundleMembers
			);
			const requiredFailures = result.failures.filter(
				({ member }) => member.required
			);
			const manualNote = describeBundleManualSteps(result.manual);
			if (requiredFailures.length > 0) {
				sileo.error({
					title: "Bundle installed with required items missing",
					...(manualNote ? { description: manualNote } : {}),
				});
			} else if (manualNote) {
				sileo.warning({
					title: tl("Installed {length} bundle items", {
						length: String(result.completed.length),
					}),
					description: manualNote,
				});
			} else {
				sileo.success({
					title: tl("Installed {length} bundle items", {
						length: String(result.completed.length),
					}),
				});
			}
			Promise.resolve(
				qc.invalidateQueries({ queryKey: ["marketplace"] })
			).catch(() => undefined);
			clear();
		} catch (e) {
			sileo.error({
				title: e instanceof Error ? e.message : "Bundle install failed",
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
				sileo.success({
					title: tl("Switched to {name}", { name: existingNode.name }),
				});
			} else {
				// Avoid a name clash with an unrelated saved node (Core rejects dupes).
				const taken = new Set(nodes.map((n) => n.name));
				let name = intent.name;
				for (let i = 2; taken.has(name); i++) {
					name = `${intent.name}-${i}`;
				}
				await addNode(name, intent.url, intent.token ?? undefined);
				await setDefaultNode(name);
				sileo.success({ title: tl("Connected to {name}", { name }) });
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
		body = modelBody(intent, modelDetail, runModel, tl);
	} else if (intent?.kind === "skill") {
		body = skillBody(intent, skillDetail, runSkill, tl);
	} else if (intent?.kind === "app") {
		body = appBody(intent, appDetail, installedApp, runApp, tl);
	} else if (intent?.kind === "bundle") {
		body = bundleBody(intent, bundleDetail, runBundle, tl);
	} else if (intent?.kind === "node") {
		body = nodeBody(intent, existingNode !== undefined, runNode, tl);
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
				{/* One note at most: a block wins over a warning, which wins over the
				    install target. */}
				{body.blockedReason ? (
					<p className="text-sm text-status-destructive" role="note">
						{tl("{blockedReason} It can't be installed on this node.", {
							blockedReason: body.blockedReason,
						})}
					</p>
				) : body.warning ? (
					<p className="text-sm text-status-warning" role="note">
						{body.warning}
					</p>
				) : intent.kind === "model" ||
					intent.kind === "skill" ||
					intent.kind === "app" ||
					intent.kind === "bundle" ? (
					<p className="text-detail text-muted-foreground">
						{tlRich(
							"Installing on <span>{name}</span>{hint, select, unresolved {. The link named a node you haven't added, so your active node is used.} other {}}",
							{
								name: installNode.name,
								hint: hintUnresolved ? "unresolved" : "resolved",
							},
							{
								span: (c) => (
									<span className="font-medium text-foreground">{c}</span>
								),
							}
						)}
					</p>
				) : null}
				<DialogFooter>
					<Button disabled={busy} onClick={close} type="button" variant="ghost">
						{body.confirm ? "Cancel" : "Close"}
					</Button>
					{body.confirm ? (
						<Button
							disabled={busy || body.blockedReason !== undefined}
							onClick={body.onConfirm}
							type="button"
							variant="mono"
						>
							<TextSwap>{busy ? "Working…" : body.confirm}</TextSwap>
						</Button>
					) : null}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
