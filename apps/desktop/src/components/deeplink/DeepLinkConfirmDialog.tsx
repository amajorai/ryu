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
	fetchSkillDetail,
	installSkill,
	type SkillDetail,
} from "@/src/lib/api/skills.ts";
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

const HTTP_PREFIX = /^https?:\/\//;
const TRAILING_SLASH = /\/$/;

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
	const pending = useDeepLinkStore((s) => s.pending);
	const clear = useDeepLinkStore((s) => s.clear);
	const qc = useQueryClient();
	const node = useActiveNode();
	const target: ApiTarget = { url: node.url, token: node.token ?? null };
	const nodes = useNodeStore((s) => s.nodes);
	const addNode = useNodeStore((s) => s.addNode);
	const setDefaultNode = useNodeStore((s) => s.setDefault);
	const [busy, setBusy] = useState(false);

	const intent = pending?.intent ?? null;
	const open = intent !== null;

	const modelDetail = useQuery({
		queryKey: ["deeplink", "model", target.url, pending?.nonce, intent?.id],
		queryFn: () => fetchModelDetail(target, intent?.id as string),
		enabled: open && intent?.kind === "model",
	});

	const skillDetail = useQuery({
		queryKey: ["deeplink", "skill", target.url, pending?.nonce, intent?.id],
		queryFn: () => fetchSkillDetail(target, intent?.id as string),
		enabled: open && intent?.kind === "skill",
	});

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
			await installSkill(target, intent.id);
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

	const sameUrl = (a: string, b: string) =>
		a.replace(TRAILING_SLASH, "") === b.replace(TRAILING_SLASH, "");
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
