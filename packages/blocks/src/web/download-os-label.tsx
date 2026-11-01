import { cn } from "@ryu/ui/lib/utils";
import {
	archLabel,
	type DownloadArch,
	type DownloadOS,
	osName,
} from "./download-platform.ts";
import { OS_SVGL, SvglIcon } from "./svgl-icon.tsx";

/**
 * "Download for <OS logo>" — the compact label of the landing hero's download
 * button. The installer already targets the visitor's own OS, so the logo alone
 * names it (the OS name stays in the accessible text). The CPU architecture
 * morphs in beside the logo only while the button is hovered or focused, which
 * keeps the resting label short. The parent button must carry `group/download`.
 */
export function DownloadOsLabel({
	arch,
	detected,
	iconSize,
	os,
}: {
	/** `null` until detection settles; the architecture is then left out. */
	arch: DownloadArch | null;
	/** False on the server and first paint, when `os` is still the default guess. */
	detected: boolean;
	iconSize: number;
	os: DownloadOS;
}) {
	return (
		<span className="inline-flex items-center">
			<span className="mr-1.5">Download for</span>
			<span
				className={cn(
					"inline-flex items-center transition-opacity duration-200 motion-reduce:transition-none",
					// The server guesses macOS; hide that guess until the browser has
					// said which OS it is, so Windows and Linux visitors never see an
					// Apple logo flash. The slot keeps its width, so nothing shifts.
					detected ? "opacity-100" : "opacity-0"
				)}
				data-os={os}
				data-slot="download-os-logo"
			>
				<SvglIcon size={iconSize} spec={OS_SVGL[os]} />
				<span className="sr-only">{osName(os)}</span>
			</span>
			{arch ? (
				<span
					className="grid grid-cols-[minmax(0,0fr)] opacity-0 transition-[grid-template-columns,opacity] duration-300 ease-out group-focus-visible/download:grid-cols-[minmax(0,1fr)] group-focus-visible/download:opacity-100 group-hover/download:grid-cols-[minmax(0,1fr)] group-hover/download:opacity-100 motion-reduce:transition-none"
					data-slot="download-arch"
				>
					<span className="min-w-0 overflow-hidden whitespace-nowrap">
						<span className="pl-1.5">{archLabel(os, arch)}</span>
					</span>
				</span>
			) : null}
		</span>
	);
}
