// `ryu secrets overrides on|off|status`: the caller's personal-overrides
// setting. On (the default), a personal value for a name wins over the shared
// team, organization or project value for it. Off, shared values win and a
// personal value only fills a name nothing shared defines. Core applies the
// setting to runtime resolution and to `export`/`run`.

import {
	getVaultPersonalOverrides,
	setVaultPersonalOverrides,
	type VaultPersonalOverrides,
} from "@ryuhq/core-client/vault";
import { tf } from "../i18n/translate.ts";
import type { SecretsArgs } from "./secrets-args.ts";
import { printJson } from "./secrets-output.ts";
import { type CliContext, UsageError } from "./types.ts";

const USAGE = "Usage: ryu-cli secrets overrides [status|on|off]";

function describe(ctx: CliContext, setting: VaultPersonalOverrides): void {
	ctx.io.out(
		`${
			setting.enabled
				? tf(
						"Personal overrides are on for {user}: your personal values win over shared team, organization and project values.",
						{ user: setting.userId }
					)
				: tf(
						"Personal overrides are off for {user}: shared team, organization and project values win, and your personal values only fill names they do not define.",
						{ user: setting.userId }
					)
		}\n`
	);
}

export async function overrides(
	ctx: CliContext,
	args: SecretsArgs
): Promise<number> {
	const action = args.positional[1] ?? "status";
	let setting: VaultPersonalOverrides;
	if (action === "status") {
		setting = await getVaultPersonalOverrides(ctx.target);
	} else if (action === "on" || action === "off") {
		setting = await setVaultPersonalOverrides(ctx.target, action === "on");
	} else {
		throw new UsageError(USAGE);
	}
	if (ctx.flags.json) {
		printJson(ctx, setting);
	} else {
		describe(ctx, setting);
	}
	return 0;
}
