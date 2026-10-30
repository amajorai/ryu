// Plugins tab lifecycle helpers — typed refusal parsing and state chips shared by
// the tab component (plugins.tsx) and its list rows (plugins-list.tsx).

import {
	type AppInfo,
	type AppLifecycleError,
	type DependencyError,
	dependencyErrorSchema,
} from "@ryuhq/core-client/plugins";
import { z } from "zod";
import type { useTheme } from "@/components/ui/theme-provider.tsx";
import { nativeErrorMessage } from "../core/native-errors.ts";

export const NAME_WIDTH = 20;
export const STATE_WIDTH = 12;

export type ThemeValue = ReturnType<typeof useTheme>;

// A destructive action the dependency graph refused, remembered so pressing C can
// retry the SAME action with cascade:true (disable/uninstall the dependents too).
export interface PendingCascade {
	/** Ids Core named as blocking the action; the cascade also acts on these. */
	dependents: string[];
	id: string;
	kind: "disable" | "uninstall";
	name: string;
}

// A destructive action held until the user answers the inline ConfirmPrompt.
export interface PendingConfirm {
	confirmLabel: string;
	consequence: string;
	run: () => void;
	title: string;
}

// The shape core-client throws: `Object.assign(new Error(msg), AppLifecycleError)`.
// We read the typed fields to decide which follow-up to OFFER (the readable line is
// already `err.message`), never by string-parsing prose.
export type LifecycleErrorLike = Partial<AppLifecycleError> & {
	message: string;
};

const nativeErrorAdmissionSchema = z.instanceof(Error);
const nativeLifecycleErrorSchema = z.object({
	builtIn: z.boolean().optional().catch(undefined),
	dependencyError: dependencyErrorSchema.nullable().optional().catch(null),
	hint: z.string().nullable().optional().catch(null),
	gatewayUnreachable: z.boolean().optional().catch(undefined),
	grantsDenied: z.boolean().optional().catch(undefined),
});

export function asLifecycleError(
	err: Parameters<typeof nativeLifecycleErrorSchema.safeParse>[0]
): LifecycleErrorLike {
	const admitted = nativeErrorAdmissionSchema.safeParse(err);
	const parsed = nativeLifecycleErrorSchema.safeParse(err);
	if (!(admitted.success && parsed.success)) {
		return { message: nativeErrorMessage(err) };
	}
	const e = parsed.data;
	return {
		message: admitted.data.message,
		builtIn: e.builtIn,
		dependencyError: e.dependencyError ?? null,
		hint: e.hint ?? null,
		gatewayUnreachable: e.gatewayUnreachable,
		grantsDenied: e.grantsDenied,
	};
}

/** True when the refusal was a 409 `blocked_by_dependents` — the one case a cascade
 *  retry resolves. */
export function blockedByDependents(err: LifecycleErrorLike): boolean {
	const dep: DependencyError | null | undefined = err.dependencyError;
	return dep?.code === "blocked_by_dependents";
}

// ── State labelling ───────────────────────────────────────────────────────────

export interface StateChip {
	color: (t: ThemeValue) => string;
	label: string;
}

export function chipFor(app: AppInfo): StateChip {
	if (!app.installed) {
		return { label: "available", color: (t) => t.colors.mutedForeground };
	}
	if (app.enabled) {
		return { label: "enabled", color: (t) => t.colors.success };
	}
	return { label: "disabled", color: (t) => t.colors.mutedForeground };
}
