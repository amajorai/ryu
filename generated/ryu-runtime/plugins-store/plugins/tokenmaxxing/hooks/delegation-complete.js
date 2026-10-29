// Tokenmaxxing lifecycle hook. This flat fragment is hydrated by Core from
// code_file and runs with only ctx and the grant-gated host facade.

const event = ctx?.event;
if (!event) return { kind: "none" };

const runId = parsePrimitiveText(event.run_id) !== undefined ? event.run_id.trim() : "";
const agentId = parsePrimitiveText(event.agent_id) !== undefined ? event.agent_id.trim() : "";
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
	if (parsePrimitiveText(stored) !== undefined && stored.length > 0) previous = JSON.parse(stored);
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

// run_active_count counts every delegate the fan-out queued, including those
// still waiting for a concurrency permit, so it reaches 0 only when the run's
// last delegate finishes. Notify on any drop to zero, not only 1-to-0: Core
// dispatches transitions on separate tasks, so the final 0 can be processed
// before the 1 it followed and that 1 is then dropped as stale above.
if (
	!previous ||
	!Number.isInteger(previous.run_active_count) ||
	previous.run_active_count < 1 ||
	runActiveCount !== 0
) {
	return { kind: "none" };
}

try {
	await host.notify({
		title: "Delegated agents finished",
		body: `All delegated agents finished (${agentId}).`,
	});
} catch {
	// Restore the prior state so an identical lifecycle delivery can retry once
	// notification permission or the active notification store is available.
	try {
		if (previous) await host.storage.set(key, JSON.stringify(previous));
	} catch {
		// Both effects are best effort; never fail the delegation lifecycle.
	}
}
return { kind: "none" };

// Decode with the native String internal-slot check; boxed strings remain
// non-text inputs. This flat sandbox fragment needs no module imports.
function parsePrimitiveText(value) {
	try {
		const parsed = String.prototype.valueOf.call(value);
		return parsed === value ? parsed : undefined;
	} catch {
		return undefined;
	}
}
