import {
	fitBlockReason,
	isSlowFit,
	SLOW_FIT_WARNING,
} from "@ryu/blocks/desktop/model-fit.ts";
import type { LiteralMessage } from "@ryu/i18n/react";
import type { MarketplaceDetail } from "@/src/lib/api/marketplace.ts";
import type {
	ModelDetail,
	SetActiveModelResult,
} from "@/src/lib/api/models.ts";
import type { AppInfo, PluginCatalogDetail } from "@/src/lib/api/plugins.ts";
import type { SkillDetail } from "@/src/lib/api/skills.ts";
import { pickRecommendedQuant } from "@/src/lib/deep-link.ts";

export interface DialogBody {
	/** Why the confirm action is disabled (e.g. the model won't fit this node). */
	blockedReason?: string;
	confirm?: string;
	description: string;
	error?: boolean;
	onConfirm?: () => void;
	title: string;
	/** A non-blocking caution shown above the actions (e.g. "may be slow"). */
	warning?: string;
}

interface DetailQuery<T> {
	data: T | undefined;
	error: unknown;
	isLoading: boolean;
}

/** Honest switch-result wording: the served-model override only affects
 * llama.cpp, so only claim "Now serving" when that engine actually reloaded. */
export function switchTitle(
	name: string,
	res: SetActiveModelResult,
	tl: LiteralMessage
): string {
	if (res.restarted && res.engine === "llamacpp") {
		return tl("Now serving {name}", { name });
	}
	if (res.engine && res.engine !== "llamacpp") {
		return tl("{name} selected (applies when llama.cpp is the active engine)", {
			name,
		});
	}
	return tl("{name} selected (takes effect on next engine start)", { name });
}

/** The dialog content for a model intent, derived from the detail query state. */
export function modelBody(
	intent: { id: string },
	q: DetailQuery<ModelDetail>,
	run: () => void,
	tl: LiteralMessage
): DialogBody {
	if (q.isLoading) {
		return { title: "Loading model…", description: intent.id };
	}
	if (q.error || !q.data) {
		return {
			title: "Model not found",
			description: tl('Could not load "{id}".', { id: intent.id }),
			error: true,
		};
	}
	const { card, files } = q.data;
	if (card.installed) {
		return {
			title: tl("Switch to {name}?", { name: card.name }),
			description: tl(
				"{name} is installed. Switch the local engine to serve it now?",
				{ name: card.name }
			),
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
	// The recommended quant is blocked only when every quant is: Core would
	// refuse the install, so the confirm stays disabled with the reason shown.
	const blockedReason = fitBlockReason(
		quant.fit,
		quant.fitLabel,
		q.data.device
	);
	return {
		title: `Install ${card.name}?`,
		description: tl(
			"Download {filename} ({sizeHuman}{fit}) and use it as the active model.",
			{ filename: quant.filename, sizeHuman: quant.sizeHuman, fit }
		),
		confirm: "Install & use",
		onConfirm: run,
		...(blockedReason ? { blockedReason } : {}),
		...(isSlowFit(quant.fit) ? { warning: SLOW_FIT_WARNING } : {}),
	};
}

/** The dialog content for a skill intent. */
export function skillBody(
	intent: { id: string },
	q: DetailQuery<SkillDetail>,
	run: () => void,
	tl: LiteralMessage
): DialogBody {
	if (q.isLoading) {
		return { title: "Loading skill…", description: intent.id };
	}
	if (q.error || !q.data) {
		return {
			title: "Skill not found",
			description: tl('Could not load "{id}".', { id: intent.id }),
			error: true,
		};
	}
	const { card, description } = q.data;
	if (card.installed) {
		return {
			title: tl("{name} is installed", { name: card.name }),
			description: "This skill is already installed.",
		};
	}
	return {
		title: `Install ${card.name}?`,
		description:
			description ?? tl("Install the {name} skill.", { name: card.name }),
		confirm: "Install",
		onConfirm: run,
	};
}

/** The dialog content for an app intent. Installed state comes from `/api/apps`
 *  (the lifecycle record) rather than the catalog detail, which carries no
 *  installed flag. */
export function appBody(
	intent: { id: string },
	q: DetailQuery<PluginCatalogDetail>,
	installed: AppInfo | undefined,
	run: () => void,
	tl: LiteralMessage
): DialogBody {
	if (q.isLoading) {
		return { title: "Loading app…", description: intent.id };
	}
	const name = q.data?.name ?? installed?.name ?? intent.id;
	if (installed?.installed) {
		return {
			title: tl("{name} is installed", { name }),
			description: "This app is already installed.",
		};
	}
	if (q.error || !q.data) {
		return {
			title: "App not found",
			description: tl('Could not load "{id}".', { id: intent.id }),
			error: true,
		};
	}
	return {
		title: `Install ${name}?`,
		description: q.data.description ?? tl("Install the {name} app.", { name }),
		confirm: "Install",
		onConfirm: run,
	};
}

/** The confirmation copy for a Marketplace bundle action. */
export function bundleBody(
	intent: { id: string },
	q: DetailQuery<MarketplaceDetail>,
	run: () => void,
	tl: LiteralMessage
): DialogBody {
	if (q.isLoading) {
		return { title: "Loading bundle…", description: intent.id };
	}
	if (q.error || !q.data) {
		return {
			title: "Bundle not found",
			description: tl('Could not load "{id}".', { id: intent.id }),
			error: true,
		};
	}
	const required = q.data.bundleMembers.filter(
		(member) => member.required
	).length;
	return {
		title: `Install ${q.data.name}?`,
		description: tl(
			"Install {length} Marketplace items ({required} required) through their existing trusted installers. Packages remain disabled until you review their permissions.",
			{
				length: String(q.data.bundleMembers.length),
				required: String(required),
			}
		),
		confirm: "Install bundle",
		onConfirm: run,
	};
}

const HTTP_PREFIX = /^https?:\/\//;
const TRAILING_SLASH = /\/$/;

/** Compare two node base URLs ignoring a trailing slash. */
export function sameUrl(a: string, b: string): boolean {
	return a.replace(TRAILING_SLASH, "") === b.replace(TRAILING_SLASH, "");
}

/** The dialog content for a node-connect intent. */
export function nodeBody(
	intent: { name: string; url: string; token: string | null },
	alreadyKnown: boolean,
	run: () => void,
	tl: LiteralMessage
): DialogBody {
	const host = intent.url.replace(HTTP_PREFIX, "");
	if (alreadyKnown) {
		return {
			title: tl("Switch to {name}?", { name: intent.name }),
			description: tl(
				"{host} is already a saved node. Make it the active node?",
				{
					host,
				}
			),
			confirm: "Switch",
			onConfirm: run,
		};
	}
	const auth = intent.token ? " (authenticated)" : "";
	return {
		title: tl("Connect to {name}?", { name: intent.name }),
		description: tl(
			"Add {host}{auth} as a node and make it active. Only connect to nodes you trust.",
			{ host, auth }
		),
		confirm: "Connect",
		onConfirm: run,
	};
}
