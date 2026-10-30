import { EngineInstallButton } from "@ryu/blocks/desktop/store-engines.tsx";
import type { ComponentProps } from "react";
import { useInstallProgress } from "@/src/store/useDownloadsStore.ts";

export function LiveEngineInstallButton({
	engineName,
	statusKnown = true,
	...props
}: { engineName: string; statusKnown?: boolean } & Omit<
	ComponentProps<typeof EngineInstallButton>,
	"percent"
>) {
	const { percent } = useInstallProgress(
		["engine", "voice", "media", "embedding"],
		engineName
	);
	return statusKnown ? (
		<EngineInstallButton percent={percent} {...props} />
	) : (
		<span className="text-muted-foreground text-xs">Status unknown</span>
	);
}
