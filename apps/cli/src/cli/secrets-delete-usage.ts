// The credential-usage check before `ryu secrets delete NAME`: broker
// services name their credentials as `secret:NAME` references in their auth
// block and substitutions, so deleting a value they reference would break
// them silently. The delete is refused, naming those services, unless
// `--force` says it is intended. Only names are read; nothing here touches a
// value. When the services cannot be listed (no `list` on `sys/broker`, an
// older node) the delete goes ahead, as before this check existed.

import {
	listVaultBrokerServices,
	type VaultBrokerService,
} from "@ryuhq/core-client/vault";
import { tf } from "../i18n/translate.ts";
import type { CliContext } from "./types.ts";

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The services whose auth or substitutions reference `secret:NAME`, in the
 *  given environment when one is named. */
export function servicesReferencing(
	services: readonly VaultBrokerService[],
	name: string,
	environment?: string
): string[] {
	const reference = new RegExp(`secret:${escapeRegExp(name)}(?![A-Za-z0-9_])`);
	return services
		.filter(
			(service) =>
				(environment === undefined || service.environment === environment) &&
				reference.test(
					JSON.stringify([service.auth, service.substitutions ?? []])
				)
		)
		.map((service) => service.name)
		.sort();
}

/** Exit code 1 (with a message) when broker services use `name` and the
 *  caller did not pass `--force`, else null. */
export async function refuseDeletingUsedCredential(
	ctx: CliContext,
	name: string,
	environment?: string
): Promise<number | null> {
	if (ctx.flags.force) {
		return null;
	}
	let services: VaultBrokerService[];
	try {
		({ services } = await listVaultBrokerServices(ctx.target));
	} catch {
		return null;
	}
	const using = servicesReferencing(services, name, environment);
	if (using.length === 0) {
		return null;
	}
	ctx.io.err(
		`${tf(
			"Refusing to delete {name}: broker services use it ({services}). Update them first, or pass --force to delete it anyway.",
			{ name, services: using.join(", ") }
		)}\n`
	);
	return 1;
}
