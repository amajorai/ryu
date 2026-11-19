// A refused app/plugin lifecycle action (enable, disable, install, uninstall,
// update) in the CLI's language. core-client folds its refusal into an English
// `err.message`; this rebuilds the sentence from the typed fields it attaches
// (`dependencyError`, `grantsDenied`, `gatewayUnreachable`) with the same
// English keys as apps/desktop/src/lib/api/plugins-lifecycle-errors.ts, so the
// CLI subset carries their existing translations. The Gateway list and reason
// and the node permission are read back from core-client's own fixed English
// sentences (packages/core-client/src/plugins-errors.ts); anything else, such
// as Core's own reason, goes through trMessage and stays as sent when unknown.

import type { DependencyError } from "@ryuhq/core-client/plugins";
import { isBareVersionFloor } from "@ryuhq/core-client/plugins";
import { formatCliList } from "../i18n/format.ts";
import { CLI_TRANSLATOR, type CliTranslator } from "../i18n/translate.ts";

export type LifecycleRefusalTranslator = Pick<
	CliTranslator,
	"tf" | "trMessage"
> & { locale?: string };

export interface LifecycleRefusal {
	dependencyError?: DependencyError | null;
	gatewayUnreachable?: boolean;
	grantsDenied?: boolean;
	message: string;
}

const GRANTS_DENIED_PREFIX = "Gateway denied grants: ";
const UNREACHABLE_PREFIX = "Gateway unreachable (fail-closed): ";
const PERMISSION_WITH_NAME =
	/^You don't have permission \((.+)\) to change apps on this node\.$/u;

/** A typed dependency-graph refusal as one actionable sentence. */
export function dependencyRefusalText(
	err: DependencyError,
	translator: LifecycleRefusalTranslator = CLI_TRANSLATOR
): string {
	const { tf } = translator;
	switch (err.code) {
		case "blocked_by_dependents": {
			const names = formatCliList(
				err.dependents,
				"conjunction",
				translator.locale
			);
			return tf("{plugin} is needed by {names}. Disable {names} first.", {
				plugin: err.plugin,
				names,
			});
		}
		case "missing_dependency": {
			const values = { plugin: err.plugin, dependency: err.dependency };
			if (!err.required) {
				return tf("{plugin} needs {dependency}. Install it first.", values);
			}
			return isBareVersionFloor(err.required)
				? tf(
						"{plugin} needs {dependency} ({required} or newer). Install it first.",
						{ ...values, required: err.required }
					)
				: tf("{plugin} needs {dependency} ({required}). Install it first.", {
						...values,
						required: err.required,
					});
		}
		case "version_mismatch": {
			const values = {
				plugin: err.plugin,
				dependency: err.dependency,
				required: err.required,
				installed: err.installed,
			};
			return isBareVersionFloor(err.required)
				? tf(
						"{plugin} needs {dependency} {required} or newer, but {installed} is installed. Update it first.",
						values
					)
				: tf(
						"{plugin} needs {dependency} {required}, but {installed} is installed.",
						values
					);
		}
		case "dependent_version_mismatch":
			return tf(
				"Updating {dependency} to {incoming} would break {plugin}, which needs {required}. Update {plugin} first.",
				{
					dependency: err.dependency,
					incoming: err.incoming,
					plugin: err.plugin,
					required: err.required,
				}
			);
		case "invalid_version_req":
			return tf(
				'{plugin} declares an invalid version requirement for {dependency} ("{requirement}"): {reason}.',
				{
					plugin: err.plugin,
					dependency: err.dependency,
					requirement: err.requirement,
					reason: err.reason,
				}
			);
		case "cycle":
			return tf("Circular dependency: {cycle}.", {
				cycle: err.cycle.join(" → "),
			});
		case "self_dependency":
			return tf("{plugin} declares itself as a dependency.", {
				plugin: err.plugin,
			});
		case "not_installed":
			return tf("{plugin} is not installed.", { plugin: err.plugin });
		default:
			return tf(
				"This change conflicts with the current plugin dependencies.",
				{}
			);
	}
}

function gatewayRefusalText(
	err: LifecycleRefusal,
	translator: LifecycleRefusalTranslator
): string | null {
	const { tf } = translator;
	if (err.grantsDenied && err.message.startsWith(GRANTS_DENIED_PREFIX)) {
		return tf("Gateway denied grants: {denied}", {
			denied: err.message.slice(GRANTS_DENIED_PREFIX.length),
		});
	}
	if (
		err.grantsDenied &&
		err.message === "Gateway denied one or more permission grants."
	) {
		return tf("Gateway denied one or more permission grants.", {});
	}
	if (err.gatewayUnreachable && err.message.startsWith(UNREACHABLE_PREFIX)) {
		const raw = err.message.slice(UNREACHABLE_PREFIX.length);
		const reason =
			raw === "gateway unreachable"
				? tf("gateway unreachable", {})
				: translator.trMessage(raw);
		return tf("Gateway unreachable (fail-closed): {reason}", { reason });
	}
	return null;
}

function permissionRefusalText(
	message: string,
	translator: LifecycleRefusalTranslator
): string | null {
	const { tf } = translator;
	if (message === "You don't have permission to change apps on this node.") {
		return tf("You don't have permission to change apps on this node.", {});
	}
	const permission = PERMISSION_WITH_NAME.exec(message)?.[1];
	return permission
		? tf(
				"You don't have permission ({permission}) to change apps on this node.",
				{ permission }
			)
		: null;
}

/** The refusal's reason in the CLI's language, ready for a toast or stderr. */
export function lifecycleRefusalText(
	err: LifecycleRefusal,
	translator: LifecycleRefusalTranslator = CLI_TRANSLATOR
): string {
	if (err.dependencyError) {
		return dependencyRefusalText(err.dependencyError, translator);
	}
	return (
		gatewayRefusalText(err, translator) ??
		permissionRefusalText(err.message, translator) ??
		translator.trMessage(err.message)
	);
}
