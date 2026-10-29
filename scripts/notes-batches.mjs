// Shared by private train and public mirror. Limits bound requests, never history.
export function batches(items) {
	const count = Number(process.env.AI_NOTES_BATCH_SIZE || 20);
	const bytes = Number(process.env.AI_NOTES_BATCH_BYTES || 80_000);
	if (
		!Number.isSafeInteger(count) ||
		count < 1 ||
		!Number.isSafeInteger(bytes) ||
		bytes < 1
	) {
		throw new Error("Invalid release-note batch limits");
	}
	const result = [];
	let batch = [];
	let size = 0;
	for (const item of items) {
		const length = Buffer.byteLength(JSON.stringify(item));
		if (length > bytes) {
			throw new Error(
				"A release-note input exceeds the batch byte limit; raise AI_NOTES_BATCH_BYTES"
			);
		}
		if (batch.length && (batch.length >= count || size + length > bytes)) {
			result.push(batch);
			batch = [];
			size = 0;
		}
		batch.push(item);
		size += length;
	}
	if (batch.length) {
		result.push(batch);
	}
	return result;
}

// Admit the ledger's primitive string field without coercing boxed strings or
// invoking user-defined conversion hooks. This shared script also runs in the
// dependency-free public mirror.
function ledgerSummaryString(value) {
	try {
		const parsed = String.prototype.valueOf.call(value);
		return value === parsed ? parsed : null;
	} catch {
		return null;
	}
}

export function validateCoverage(entries, expected, key, text) {
	if (!Array.isArray(entries)) {
		throw new Error("Missing change ledger");
	}
	const wanted = new Set(expected);
	const seen = new Set();
	for (const entry of entries) {
		const id = key(entry);
		if (
			!wanted.has(id) ||
			seen.has(id) ||
			ledgerSummaryString(text(entry)) === null ||
			!text(entry).trim()
		) {
			throw new Error("Invalid or duplicate change ledger entry");
		}
		seen.add(id);
	}
	if (seen.size !== wanted.size) {
		throw new Error(`Incomplete AI coverage: ${seen.size}/${wanted.size}`);
	}
}

export async function consolidateHighlights(items, request, limit) {
	if (items.length < 2) {
		return items;
	}
	const merge = async (group) => {
		for (let attempt = 0; attempt < 3; attempt++) {
			const result = await request([
				{
					role: "system",
					content: `Consolidate these release highlights into at most ${limit} distinct highlights, combining overlapping capabilities. Preserve the input shape, package names and factual meaning. Never invent facts. Use short capability titles and one or two paragraphs per highlight, with two to four sentences and at most 120 words per paragraph. Lead with shipped user behavior. Leave file names, component inventories and test implementation details in the complete ledger. Select the most significant capabilities rather than combining unrelated changes into a long inventory. Return strict JSON: {"highlights": [...], "changes": []}. The full change ledger is preserved separately.`,
				},
				{ role: "user", content: JSON.stringify(group) },
			]);
			if (
				Array.isArray(result.highlights) &&
				result.highlights.length &&
				result.highlights.length <= limit
			) {
				return result.highlights;
			}
			process.stderr.write(
				"release-notes: retrying invalid overview consolidation\n"
			);
		}
		throw new Error("Invalid consolidated highlights");
	};
	let current = items;
	while (current.length > 8) {
		const next = [];
		const groups = [];
		for (let index = 0; index < current.length; index += 8) {
			groups.push(current.slice(index, index + 8));
		}
		// Independent groups can merge together, with bounded provider concurrency.
		for (let index = 0; index < groups.length; index += 4) {
			process.stderr.write(
				`release-notes: consolidating overview groups ${index + 1}-${Math.min(index + 4, groups.length)}/${groups.length}\n`
			);
			const merged = await Promise.all(
				groups
					.slice(index, index + 4)
					.map((group) => (group.length > 1 ? merge(group) : group))
			);
			for (const group of merged) {
				next.push(...group);
			}
		}
		if (next.length >= current.length) {
			throw new Error("Highlight consolidation made no progress");
		}
		current = next;
	}
	// Final pass sees every surviving batch's candidates together, even when the
	// overview already fits the count limit, so overlaps across batches can merge.
	return current.length > 1 ? merge(current) : current;
}

// Split oversized private pair inputs without dropping message text or paths.
// Fragment IDs remain distinct until a second model pass consolidates the pair.
export function fragmentPairs(items) {
	const budget = Number(process.env.AI_NOTES_BATCH_BYTES || 80_000);
	const result = [];
	for (const item of items) {
		if (Buffer.byteLength(JSON.stringify(item)) <= budget) {
			result.push(item);
			continue;
		}
		const base = { ...item, body: "", files: [] };
		const room = budget - Buffer.byteLength(JSON.stringify(base)) - 256;
		if (room < 1024) {
			throw new Error("Batch byte limit is too small for commit metadata");
		}
		const chunks = [];
		let text = "";
		let size = 0;
		for (const character of item.body) {
			const bytes = Buffer.byteLength(JSON.stringify(character));
			if (size + bytes > room / 2) {
				chunks.push(text);
				text = "";
				size = 0;
			}
			text += character;
			size += bytes;
		}
		if (text || !chunks.length) {
			chunks.push(text);
		}
		const fileGroups = [];
		let files = [];
		size = 0;
		for (const file of item.files) {
			const bytes = Buffer.byteLength(JSON.stringify(file)) + 1;
			if (bytes > room / 2) {
				throw new Error("Changed path exceeds batch limit");
			}
			if (files.length && size + bytes > room / 2) {
				fileGroups.push(files);
				files = [];
				size = 0;
			}
			files.push(file);
			size += bytes;
		}
		if (files.length || !fileGroups.length) {
			fileGroups.push(files);
		}
		const count = Math.max(chunks.length, fileGroups.length);
		for (let index = 0; index < count; index++) {
			result.push({
				...base,
				originalShort: item.short,
				short: `${item.short}:${index + 1}`,
				body: chunks.length === 1 ? chunks[0] : chunks[index] || "",
				files:
					fileGroups.length === 1 ? fileGroups[0] : fileGroups[index] || [],
			});
		}
	}
	return result;
}

// Retry-After is delta-seconds or an HTTP-date; undefined when absent or invalid.
export function retryAfterMs(header, now = Date.now()) {
	const value = typeof header === "string" ? header.trim() : "";
	if (/^\d+$/.test(value)) {
		return Number(value) * 1000;
	}
	const date = value ? Date.parse(value) : Number.NaN;
	return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

// An HTTP failure that carries what retryModelCall needs to decide and wait.
export function modelHttpError(response, message) {
	const error = new Error(message);
	error.status = response.status;
	error.retryAfterMs = retryAfterMs(response.headers.get("retry-after"));
	return error;
}

const MAX_BACKOFF_MS = 30_000;
const MAX_RETRY_AFTER_MS = 60_000;

// Milliseconds to wait before retrying `error`, or null when retrying cannot
// help. Rate limits, timeouts, server errors and dropped connections back off
// (honouring Retry-After); a rejected key or request fails at once; an
// incomplete or unparseable answer retries at once, since waiting changes nothing.
function retryDelay(error, attempt, random) {
	const jitter = Math.floor(random() * 1000);
	const backoff = Math.min(MAX_BACKOFF_MS, 2000 * 2 ** attempt) + jitter;
	const status = error?.status;
	if (typeof status === "number") {
		if (status >= 400 && status < 500 && status !== 408 && status !== 429) {
			return null;
		}
		return Number.isFinite(error.retryAfterMs)
			? Math.min(error.retryAfterMs, MAX_RETRY_AFTER_MS) + jitter
			: backoff;
	}
	const transport =
		error?.name === "TimeoutError" ||
		error?.name === "AbortError" ||
		error instanceof TypeError;
	return transport ? backoff : 0;
}

const defaultSleep = (ms) =>
	new Promise((resolve) => {
		setTimeout(resolve, ms);
	});

// Shared by both generators: bounded attempts (AI_NOTES_ATTEMPTS, default 3)
// with backoff for transient provider failures, so a 429 cannot burn every
// attempt in seconds.
export async function retryModelCall(
	operation,
	{
		attempts = Number(process.env.AI_NOTES_ATTEMPTS || 3),
		random = Math.random,
		sleep = defaultSleep,
	} = {}
) {
	if (!Number.isSafeInteger(attempts) || attempts < 1) {
		throw new Error("Invalid AI_NOTES_ATTEMPTS");
	}
	let failure;
	for (let attempt = 0; attempt < attempts; attempt++) {
		try {
			return await operation();
		} catch (error) {
			failure = error;
			const delay = retryDelay(error, attempt, random);
			if (delay === null) {
				throw error;
			}
			if (delay > 0 && attempt < attempts - 1) {
				process.stderr.write(
					`release-notes: model call failed (${String(error?.message).slice(0, 200)}); retrying in ${Math.ceil(delay / 1000)}s\n`
				);
				await sleep(delay);
			}
		}
	}
	throw failure;
}

// Recover model budget/coverage failures by reviewing smaller subsets. Transport
// and credential failures remain failures, so retries do not fan out HTTP errors.
export async function reviewWithSplitting(batch, request) {
	try {
		return await request(batch);
	} catch (error) {
		const recoverable =
			error instanceof SyntaxError ||
			/Incomplete AI coverage|Invalid or duplicate change ledger|Missing change ledger|no changes array|model output was not JSON|model returned no content|Incomplete model output/.test(
				error.message
			);
		if (batch.length < 2 || !recoverable) {
			throw error;
		}
		process.stderr.write(
			`release-notes: retrying incomplete batch as smaller groups (${batch.length} inputs)\n`
		);
		const middle = Math.ceil(batch.length / 2);
		const left = await reviewWithSplitting(batch.slice(0, middle), request);
		const right = await reviewWithSplitting(batch.slice(middle), request);
		return {
			changes: [...left.changes, ...right.changes],
			highlights: [...(left.highlights || []), ...(right.highlights || [])],
			breaking: [...(left.breaking || []), ...(right.breaking || [])],
		};
	}
}
