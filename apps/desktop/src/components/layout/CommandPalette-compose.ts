import type { AttachedImage } from "@ryu/blocks/desktop/agent-elements/input-bar.tsx";
import { toast } from "@ryu/ui/components/sileo.tsx";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import { stageImageUpload } from "@/src/lib/api/uploads.ts";

/** Pick images from disk and stage them as attachments on the compose draft. */
export function attachComposeImages({
	composeGeneration,
	isCurrentTarget,
	setComposeImages,
	target,
}: {
	composeGeneration: MutableRefObject<number>;
	isCurrentTarget: () => boolean;
	setComposeImages: Dispatch<SetStateAction<AttachedImage[]>>;
	target: ApiTarget;
}): void {
	const generation = composeGeneration.current;
	const input = document.createElement("input");
	input.accept = "image/*";
	input.multiple = true;
	input.type = "file";
	input.onchange = () => {
		if (!isCurrentTarget() || generation !== composeGeneration.current) {
			return;
		}
		for (const file of Array.from(input.files ?? [])) {
			if (!file.type.startsWith("image/")) {
				continue;
			}
			void stageImageUpload(target, file)
				.then(({ dataUrl, upload }) => {
					if (!isCurrentTarget() || generation !== composeGeneration.current) {
						return;
					}
					setComposeImages((previous) => [
						...previous,
						{
							id: upload?.id ?? `img-${crypto.randomUUID()}`,
							filename: file.name,
							url: dataUrl,
							mimeType: file.type,
							size: file.size,
						},
					]);
				})
				.catch((error) => {
					if (!isCurrentTarget() || generation !== composeGeneration.current) {
						return;
					}
					toast.error("Could not attach image", {
						description:
							error instanceof Error
								? error.message
								: "Please try another image.",
					});
				});
		}
	};
	input.click();
}
