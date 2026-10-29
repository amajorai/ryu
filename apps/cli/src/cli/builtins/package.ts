// `ryu-cli package` (portable packages) and `ryu-cli action` (governed Actions).

import {
	decryptSecrets,
	hasEncryptedSecrets,
	packageSummary,
	readPackageInput,
	redactPackageTree,
	validatePublishablePackage,
	writePackageArchive,
	writePackageFolder,
} from "@ryu/portable-packages";
import { tf, tr } from "../../i18n/translate.ts";
import { localize } from "../localizedText.ts";
import { type CliContext, type Command, UsageError } from "../types.ts";
import {
	asRecord,
	type CommandJsonValue,
	callCore,
	commandJsonSchema,
} from "./shared.ts";

export function packageArg(
	ctx: CliContext,
	index: number,
	usage: string
): string {
	const value = ctx.args[index];
	if (!value) {
		throw new UsageError(localize("Usage: {usage}", { usage }));
	}
	return value;
}

function packageOutput(
	ctx: CliContext,
	value: Parameters<typeof JSON.stringify>[0],
	human: string
): void {
	ctx.io.out(
		ctx.flags.json ? `${JSON.stringify(value, null, 2)}\n` : `${human}\n`
	);
}

async function packageUnlockKey(_ctx: CliContext): Promise<string> {
	const key = process.env.RYU_PACKAGE_KEY?.trim();
	if (key) {
		return key;
	}
	if (!(process.stdin.isTTY && process.stdout.isTTY)) {
		throw new Error(
			"An encrypted package requires RYU_PACKAGE_KEY when stdin is not interactive."
		);
	}
	const { createInterface } = await import("node:readline/promises");
	const readline = createInterface({
		input: process.stdin,
		output: process.stdout,
	});
	try {
		const answer = await readline.question("Package unlock key: ");
		if (!answer.trim()) {
			throw new Error("A package unlock key is required");
		}
		return answer;
	} finally {
		readline.close();
	}
}

async function writePackageDestination(
	destination: string,
	tree: Awaited<ReturnType<typeof readPackageInput>>
): Promise<void> {
	if (destination.toLowerCase().endsWith(".ryupack")) {
		await writePackageArchive(destination, tree);
		return;
	}
	await writePackageFolder(destination, tree);
}

export const packageCommand: Command = {
	name: "package",
	aliases: ["pkg"],
	summary: "Validate, inspect, import, export, and pack portable packages",
	usage:
		"ryu-cli package <validate|inspect|pack|unpack|import|export|publish> <path> [destination]",
	run: async (ctx) => {
		const action = ctx.args[0];
		const usage =
			"ryu-cli package <validate|inspect|pack|unpack|import|export|publish> <path> [destination]";
		if (!action) {
			throw new UsageError(localize("Usage: {usage}", { usage }));
		}
		if (action === "validate" || action === "inspect") {
			const input = packageArg(ctx, 1, usage);
			const tree = await readPackageInput(input);
			const summary = packageSummary(tree);
			packageOutput(
				ctx,
				summary,
				action === "validate"
					? tf(
							"Valid package {id}@{version} ({kind}) · {count, plural, one {# file} other {# files}}",
							{
								count: summary.files.length,
								id: summary.id,
								kind: summary.kind,
								version: summary.version,
							}
						)
					: `${summary.id}@${summary.version}\n${summary.files.map((path) => `  ${path}`).join("\n")}`
			);
			return 0;
		}
		if (action === "pack") {
			const input = packageArg(ctx, 1, usage);
			const destination = ctx.args[2] ?? `${input.replace(/\/$/, "")}.ryupack`;
			const tree = await readPackageInput(input);
			await writePackageDestination(destination, tree);
			packageOutput(
				ctx,
				{ destination, ...packageSummary(tree) },
				tf("Packed {destination}", { destination })
			);
			return 0;
		}
		if (action === "unpack" || action === "import") {
			const input = packageArg(ctx, 1, usage);
			const destination = packageArg(ctx, 2, usage);
			const tree = await readPackageInput(input);
			if (action === "import" && hasEncryptedSecrets(tree)) {
				decryptSecrets(
					tree.files["secrets.enc"]!,
					await packageUnlockKey(ctx),
					tree.manifest
				);
			}
			await writePackageDestination(destination, tree);
			packageOutput(
				ctx,
				{ destination, ...packageSummary(tree) },
				tf("Imported {id} into {destination}", {
					destination,
					id: tree.manifest.id,
				})
			);
			return 0;
		}
		if (action === "export") {
			const input = packageArg(ctx, 1, usage);
			const destination = packageArg(ctx, 2, usage);
			const tree = await readPackageInput(input);
			if (!ctx.flags.includeSecrets) {
				const redacted = redactPackageTree(tree);
				await writePackageDestination(destination, redacted);
				packageOutput(
					ctx,
					{ destination, redacted: true, ...packageSummary(redacted) },
					tf("Exported redacted package to {destination}", { destination })
				);
				return 0;
			}
			if (!hasEncryptedSecrets(tree)) {
				throw new Error(
					"--include-secrets requires a package that already contains an encrypted secrets.enc envelope"
				);
			}
			decryptSecrets(
				tree.files["secrets.enc"]!,
				await packageUnlockKey(ctx),
				tree.manifest
			);
			await writePackageDestination(destination, tree);
			packageOutput(
				ctx,
				{ destination, redacted: false, ...packageSummary(tree) },
				tf("Exported package to {destination}", { destination })
			);
			return 0;
		}
		if (action === "publish") {
			const input = packageArg(ctx, 1, usage);
			const tree = await readPackageInput(input);
			validatePublishablePackage(tree);
			packageOutput(
				ctx,
				{ publishable: true, ...packageSummary(tree) },
				tf("Package {id}@{version} is publishable", {
					id: tree.manifest.id,
					version: tree.manifest.version,
				})
			);
			return 0;
		}
		throw new UsageError(localize("Usage: {usage}", { usage }));
	},
};

/** `ryu action <id> <json> --agent <agent-id>` — invoke one canonical Action
 * through Core. The explicit agent is required because Core's node token
 * authenticates the node, not the calling agent; omitting it would make the
 * allowlist/approval principal ambiguous. */
export const actionCommand: Command = {
	name: "action",
	summary: "Call one governed Action through Core",
	usage: "ryu-cli action <id> <json> --agent <agent-id>",
	run: async (ctx) => {
		const actionId = ctx.args[0];
		if (!(actionId && ctx.flags.agent)) {
			throw new UsageError(
				"Usage: ryu-cli action <id> <json> --agent <agent-id>"
			);
		}
		const rawArguments = ctx.args[1] ?? "{}";
		let argumentsValue: CommandJsonValue;
		try {
			argumentsValue = commandJsonSchema.parse(JSON.parse(rawArguments));
		} catch {
			throw new UsageError("Action arguments must be valid JSON.");
		}

		const result = ctx.api.callAction
			? await ctx.api.callAction(ctx.target, actionId, {
					agentId: ctx.flags.agent,
					arguments: argumentsValue,
				})
			: await callCore(ctx, `/api/actions/${encodeURIComponent(actionId)}`, {
					method: "POST",
					body: {
						agent_id: ctx.flags.agent,
						arguments: argumentsValue,
					},
				});

		const actionReply = asRecord(result);
		const failed = actionReply?.ok === false;
		if (ctx.flags.json) {
			ctx.io.out(`${JSON.stringify(result, null, 2)}\n`);
		} else if (failed) {
			ctx.io.out(
				`${tf("Action {id} failed: {error}", { error: String(actionReply.error ?? tr("unknown error")), id: actionId })}\n`
			);
		} else {
			ctx.io.out(`${tf("Action {id} completed.", { id: actionId })}\n`);
		}
		return failed ? 1 : 0;
	},
};
