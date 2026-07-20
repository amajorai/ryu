import { Button } from "@ryu/ui/components/button";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { sileo } from "sileo";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import { getActiveModel, setActiveModel } from "@/src/lib/api/models.ts";

/**
 * "Use this model" control shown for an installed model: switches which model the
 * local chat stack serves (the same `POST /api/models/active` a `ryu://` deep
 * link triggers). Core derives the engine from the model's format and makes it
 * resident, so this works for GGUF (llama.cpp/Ollama), safetensors (vLLM), and
 * MLX alike — the control reflects whichever engine was activated.
 */
export function ActiveModelControl({ repoId }: { repoId: string }) {
	const node = useActiveNode();
	const target: ApiTarget = { url: node.url, token: node.token ?? null };
	const qc = useQueryClient();

	const activeQuery = useQuery({
		queryKey: ["models", "active", target.url],
		queryFn: () => getActiveModel(target),
	});

	const isActive =
		activeQuery.data?.repoId === repoId || activeQuery.data?.ref === repoId;

	const switchMutation = useMutation({
		mutationFn: () => setActiveModel(target, repoId),
		onSuccess: (res) => {
			// Core swaps/restarts the derived engine, so the model is being served
			// once a swap or restart happened; otherwise it takes effect on next
			// engine start. Surface the engine that was activated.
			const engine = res.engine ?? "the local engine";
			const title =
				res.swapped || res.restarted
					? `Now serving this model on ${engine}`
					: `Selected (takes effect on next ${engine} start)`;
			sileo.success({ title });
			Promise.resolve(
				qc.invalidateQueries({ queryKey: ["models", "active", target.url] })
			).catch(() => undefined);
		},
		onError: (e) => {
			sileo.error({
				title: e instanceof Error ? e.message : "Failed to switch model",
			});
		},
	});

	let label = "Use this model";
	if (isActive) {
		label = "In use";
	} else if (switchMutation.isPending) {
		label = "Switching…";
	}

	return (
		<Button
			disabled={isActive || switchMutation.isPending}
			onClick={() => switchMutation.mutate()}
			size="sm"
			type="button"
			variant={isActive ? "secondary" : "default"}
		>
			{label}
		</Button>
	);
}
