import { Logo as OrbLogo } from "@ryu/ui/components/logo.tsx";

/** The shell's loading state: the shimmering orb, centred and draggable. Also
 *  the fallback while a lazily loaded screen's code arrives. */
export function BootSpinner() {
	return (
		<div
			className="flex h-full w-full items-center justify-center"
			data-tauri-drag-region
		>
			<OrbLogo size="56px" variant="shimmer" />
		</div>
	);
}
