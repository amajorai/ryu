import { z } from "zod";
import { CHAT_REFERENCE_DRAG_MIME } from "../components/layout/tabDnd.tsx";

export interface DraggedChatReference {
	id: string;
	label: string;
}

export function readDraggedChatReference(
	dataTransfer: DataTransfer
): DraggedChatReference | null {
	try {
		const result = z
			.object({ id: z.string(), label: z.string() })
			.safeParse(JSON.parse(dataTransfer.getData(CHAT_REFERENCE_DRAG_MIME)));
		return result.success ? result.data : null;
	} catch {
		return null;
	}
}
