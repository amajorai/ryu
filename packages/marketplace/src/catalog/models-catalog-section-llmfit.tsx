import { useLiteralMessages } from "@ryu/i18n/react";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { type ReactNode, useState } from "react";
import { useCatalogHost } from "./host.tsx";
import type { LlmFitEstimate, ModelCard } from "./types.ts";

/**
 * On-demand hardware speed/fit estimate via the optional `llmfit` tool. Renders
 * only on an install-capable surface (it needs a Core node); its node identity,
 * estimate call, and sidecar install all cross the host seam.
 */
export function LlmfitEstimateBlock({
	context,
	quant,
	repo,
}: {
	context: number | null;
	quant: string | null;
	repo: string;
}) {
	const host = useCatalogHost();
	const tl = useLiteralMessages();
	const node = host.useActiveNode();
	const [busy, setBusy] = useState<"idle" | "loading" | "installing">("idle");
	const [result, setResult] = useState<LlmFitEstimate | null>(null);
	const [error, setError] = useState<string | null>(null);
	const run = async () => {
		setBusy("loading");
		setError(null);
		try {
			setResult(
				await host.estimateLlmfit(node, repo, {
					context: context ?? undefined,
					quant: quant ?? undefined,
				})
			);
		} catch (e) {
			setError(e instanceof Error ? e.message : "Estimate failed");
		} finally {
			setBusy("idle");
		}
	};

	const install = async () => {
		setBusy("installing");
		setError(null);
		try {
			await host.installSidecar(
				node.url,
				node.token,
				"llmfit",
				node.userJwt ?? null
			);
			setResult(null);
		} catch (e) {
			setError(e instanceof Error ? e.message : "Couldn't add this model");
		} finally {
			setBusy("idle");
		}
	};

	// run()/install() capture their own errors into state and never reject, so the
	// button handlers just fire-and-forget (the project forbids the `void` op).
	const onRun = () => {
		run().catch(() => {
			// handled inside run()
		});
	};
	const onInstall = () => {
		install().catch(() => {
			// handled inside install()
		});
	};

	let body: ReactNode;
	if (result === null) {
		body = (
			<div className="flex flex-wrap items-center gap-3">
				<Button
					disabled={busy === "installing"}
					loading={busy === "loading"}
					onClick={onRun}
					size="sm"
					variant="ghost"
				>
					{busy === "loading"
						? "Estimating… (~15s)"
						: "Estimate speed on your device"}
				</Button>
				<span className="text-muted-foreground text-xs">
					See how fast this model would run on your device.
				</span>
			</div>
		);
	} else if (!result.installed) {
		body = (
			<div className="flex flex-wrap items-center gap-3">
				<Button loading={busy === "installing"} onClick={onInstall} size="sm">
					Enable speed estimates
				</Button>
				<span className="text-muted-foreground text-xs">
					Speed estimates aren’t set up on this computer yet — enable them to
					see how fast this model would run.
				</span>
			</div>
		);
	} else if (result.matched) {
		body = (
			<div className="flex flex-wrap items-center gap-2">
				{result.tps != null && (
					<Badge variant="secondary">
						{tl("≈{rate} tokens/sec", {
							rate: String(Math.round(result.tps)),
						})}
					</Badge>
				)}
				{result.fit_level && (
					<Badge variant="outline">{result.fit_level}</Badge>
				)}
				{result.min_vram_gb != null && (
					<span className="text-muted-foreground text-xs">
						{tl("needs {memory} GB graphics memory{path}", {
							memory: result.min_vram_gb.toFixed(1),
							path: result.path ? ` · ${result.path.replace("_", " ")}` : "",
						})}
					</span>
				)}
				<Button onClick={onRun} size="sm" variant="ghost">
					Re-estimate
				</Button>
			</div>
		);
	} else {
		body = (
			<div className="flex flex-wrap items-center gap-2">
				<span className="text-muted-foreground text-sm">
					No speed estimate available for this model — use the device fit above.
				</span>
				<Button onClick={onRun} size="sm" variant="ghost">
					Retry
				</Button>
			</div>
		);
	}

	return (
		<section className="flex flex-col gap-2">
			<h3 className="font-medium text-sm">Speed estimate</h3>
			{body}
			{error && <p className="text-status-destructive text-xs">{error}</p>}
		</section>
	);
}

export function modelCanChat(card: ModelCard): boolean {
	const searchable = [card.pipelineTag, ...card.tags]
		.filter(Boolean)
		.join(" ")
		.toLowerCase();
	return /(text-generation|text2text-generation|conversational|image-text-to-text|visual-question-answering|document-question-answering)/.test(
		searchable
	);
}

/**
 * Fine-tuned variants of the selected model: merged GGUFs recorded against it as
 * their base. They are installed (servable by stem), so each can be set as the
 * active model. Reads installed models across the host seam; renders nothing when
 * there are none. Install-capable surfaces only.
 */
export function FinetunedVariants({ baseId }: { baseId: string }) {
	const host = useCatalogHost();
	const tl = useLiteralMessages();
	const installed = host.useInstalledModels();
	const ActiveModelControl = host.ActiveModelControl;
	const variants = installed.filter(
		(m) => m.finetuneBase && m.finetuneBase === baseId
	);
	if (variants.length === 0) {
		return null;
	}
	return (
		<section className="flex flex-col gap-2">
			<h3 className="font-medium text-sm">Your fine-tuned versions</h3>
			<ul className="flex flex-col gap-2">
				{variants.map((m) => (
					<li
						className="flex items-center justify-between gap-3 rounded-lg bg-muted/30 px-4 py-3"
						key={m.stem}
					>
						<div className="min-w-0">
							<div className="flex items-center gap-2">
								<p className="truncate font-medium text-sm" title={m.stem}>
									{m.stem}
								</p>
								<Badge variant="secondary">Fine-tuned</Badge>
							</div>
							<p className="truncate text-muted-foreground text-xs">
								{tl("Fine-tuned from {finetuneBase}", {
									finetuneBase: m.finetuneBase,
								})}
							</p>
						</div>
						<ActiveModelControl
							chatCapable
							format="gguf"
							modelName={m.stem}
							repoId={m.stem}
						/>
					</li>
				))}
			</ul>
		</section>
	);
}
