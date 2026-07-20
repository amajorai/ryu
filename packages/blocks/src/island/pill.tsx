// The resting island pill states, composed from the real ContextPill block plus
// the shared Ryu eyes logo. Mirrors the layout in apps/island Island.tsx where a
// leading logo circle splits out beside the trailing detail pill that carries
// the text label (plain "Ryu" idle, or the live active-app name in context).
//
// The live island draws these two shapes as separate motion elements with a gap;
// here they are composed for the static storyboard surfaces.

import { Logo } from "@ryu/ui/components/logo";
import { ContextPill, type IslandActiveContext } from "./context-pill.tsx";

/** Just the eyes-tracking logo, the fully collapsed tap target. */
export function IslandLogoCircle() {
	return (
		<div className="flex h-full w-full items-center justify-center">
			<Logo className="text-neutral-100" size="34px" variant="eyes" />
		</div>
	);
}

/**
 * The detail pill split out beside the logo: a small logo badge plus the
 * ContextPill text (idle "Ryu" or the live active-app name).
 */
export function IslandDetailPill({
	context,
}: {
	context?: IslandActiveContext;
}) {
	return (
		<div className="flex h-full w-full items-center gap-3 px-3">
			<span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-white/5 ring-1 ring-white/10">
				<Logo className="text-neutral-100" size="22px" variant="eyes" />
			</span>
			<ContextPill context={context} />
		</div>
	);
}
