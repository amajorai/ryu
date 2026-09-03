// Tokenmaxxing lifecycle hook. This flat fragment is hydrated by Core from
// code_file and runs with only ctx and the grant-gated host facade.

const event = ctx?.event;
if (!event || typeof event !== "object") return { kind: "none" };

const runId = typeof event.run_id === "string" ? event.run_id.trim() : "";
const agentId = typeof event.agent_id === "string" ? event.agent_id.trim() : "";
const activeCount = event.active_count;
const runActiveCount = event.run_active_count;
const transitionId = event.transition_id;
if (
	!runId ||
	!agentId ||
	!Number.isInteger(activeCount) ||
	activeCount < 0 ||
	!Number.isInteger(runActiveCount) ||
	runActiveCount < 0 ||
	!Number.isSafeInteger(transitionId) ||
	transitionId < 1
) {
	return { kind: "none" };
}

// State is per fan-out run. Core also supplies run_active_count, so overlapping
// runs cannot suppress one another or notify only the account that happened to
// be globally active when the node drained.
const key = `tokenmaxxing:${encodeURIComponent(runId)}`;
let previous = null;
try {
	const stored = await host.storage.get(key);
	if (typeof stored === "string" && stored.length > 0) previous = JSON.parse(stored);
} catch {
	return { kind: "none" };
}

if (previous && Number.isSafeInteger(previous.transition_id) && transitionId <= previous.transition_id) {
	return { kind: "none" };
}

try {
	await host.storage.set(
		key,
		JSON.stringify({
			active_count: activeCount,
			run_active_count: runActiveCount,
			transition_id: transitionId,
		})
	);
} catch {
	return { kind: "none" };
}

if (previous?.run_active_count !== 1 || runActiveCount !== 0) return { kind: "none" };

try {
	await host.notify({
		title: "Delegated agents finished",
		body: `All delegated agents finished (${agentId}).`,
	});
} catch {
	// Notification is best effort; a missing active user/store must fail closed.
}
return { kind: "none" };
