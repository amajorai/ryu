// Rendering for `ryu secrets agent`: read the values the templates name, render
// each template, write it only when its output changed, and then run its
// command. A template that fails to render keeps its previous file, so a
// missing value never truncates a config a service is running on.
//
// The command runs when the rendered file changed, including the first render
// that creates it or finds different content, and not when the output is
// already on disk. It gets the CLI's reviewed runtime environment (no
// RYU_VAULT_TOKEN), is stopped after its timeout, and runs to completion
// before the next template renders, so two commands for one template never
// overlap.

import { readFile } from "node:fs/promises";
import {
	parseVaultJsonExport,
	type VaultAgentTarget,
	vaultAgentExport,
} from "@ryuhq/core-client/vault";
import { tf } from "../i18n/translate.ts";
import type { AgentContext } from "./secrets-agentd-auth.ts";
import type {
	AgentConfig,
	AgentTemplateConfig,
} from "./secrets-agentd-config.ts";
import { writeIfChanged } from "./secrets-agentd-files.ts";
import type { HeldLease } from "./secrets-agentd-leases.ts";
import {
	parseTemplate,
	type ResolvedReference,
	referenceKey,
	renderTemplate,
	secretReferences,
	TemplateError,
	type TemplatePart,
} from "./secrets-agentd-template.ts";
import { childRuntimeEnvironment } from "./secrets-broker.ts";
import { UsageError } from "./types.ts";

export interface LoadedTemplate {
	config: AgentTemplateConfig;
	parts: TemplatePart[];
}

/** Read and parse every template, and check that each `{{lease:…}}` names a
 *  configured lease, before anything is issued or written. */
export async function loadTemplates(
	config: AgentConfig
): Promise<LoadedTemplate[]> {
	const leaseNames = new Set(config.leases.map((lease) => lease.name));
	const loaded: LoadedTemplate[] = [];
	for (const template of config.templates) {
		const parts = parseTemplate(
			await readFile(template.source, "utf8"),
			template.source
		);
		for (const part of parts) {
			if (part.kind === "lease" && !leaseNames.has(part.lease)) {
				throw new UsageError(
					tf("{file}: {placeholder} names no configured lease.", {
						file: template.source,
						placeholder: part.source,
					})
				);
			}
		}
		loaded.push({ config: template, parts });
	}
	return loaded;
}

/** Fetch every value the templates read, one export per environment and
 *  folder. Values the token may not read are simply absent. */
export async function fetchValues(
	target: VaultAgentTarget,
	templates: LoadedTemplate[],
	defaults: AgentConfig["defaults"]
): Promise<Map<string, string>> {
	const groups = new Map<string, ResolvedReference[]>();
	for (const template of templates) {
		for (const reference of secretReferences(template.parts, defaults)) {
			const key = `${reference.environment ?? ""}\u0000${reference.path}`;
			groups.set(key, [...(groups.get(key) ?? []), reference]);
		}
	}
	const values = new Map<string, string>();
	for (const references of groups.values()) {
		const first = references[0];
		if (!first) {
			continue;
		}
		const names = [...new Set(references.map((ref) => ref.name))];
		const result = await vaultAgentExport(target, {
			format: "json",
			path: first.path,
			names,
			...(first.environment ? { environment: first.environment } : {}),
		});
		const exported = parseVaultJsonExport(result);
		for (const reference of references) {
			const value = exported[reference.name];
			if (value !== undefined) {
				values.set(referenceKey(reference), value);
			}
		}
	}
	return values;
}

async function runCommand(
	ctx: AgentContext,
	template: AgentTemplateConfig
): Promise<void> {
	if (!template.command) {
		return;
	}
	const code = await ctx.spawn(
		template.command,
		childRuntimeEnvironment(ctx.env),
		{ signal: AbortSignal.timeout(template.commandTimeoutMs) }
	);
	if (code !== 0) {
		ctx.io.err(
			`${tf("ryu agent: the command for {file} exited with {code}.", { file: template.destination, code: String(code) })}\n`
		);
	}
}

export interface RenderOutcome {
	changed: string[];
	failed: string[];
}

/** Render every template once. Values are fetched once per pass. */
export async function renderAll(
	ctx: AgentContext,
	target: VaultAgentTarget,
	config: AgentConfig,
	templates: LoadedTemplate[],
	leases: ReadonlyMap<string, HeldLease>
): Promise<RenderOutcome> {
	const values = await fetchValues(target, templates, config.defaults);
	const leaseData = new Map(
		[...leases].map(([name, held]) => [name, held.data] as const)
	);
	const outcome: RenderOutcome = { changed: [], failed: [] };
	for (const template of templates) {
		let output: string;
		try {
			output = renderTemplate(
				template.parts,
				{ defaults: config.defaults, values, leases: leaseData },
				template.config.source
			);
		} catch (error) {
			if (!(error instanceof TemplateError)) {
				throw error;
			}
			// The message names the template and placeholders, never a value.
			ctx.io.err(`${error.message}\n`);
			outcome.failed.push(template.config.destination);
			continue;
		}
		const changed = await writeIfChanged(
			template.config.destination,
			output,
			template.config.mode
		);
		if (changed) {
			outcome.changed.push(template.config.destination);
			ctx.io.err(
				`${tf("ryu agent: rendered {file}.", { file: template.config.destination })}\n`
			);
			await runCommand(ctx, template.config);
		}
	}
	return outcome;
}
