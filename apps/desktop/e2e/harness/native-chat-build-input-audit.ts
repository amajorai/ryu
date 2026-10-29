import { createHash } from "node:crypto";
import {
	closeSync,
	existsSync,
	openSync,
	readFileSync,
	readSync,
	realpathSync,
	statSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import type { Plugin } from "vite";

function hashFile(file: string) {
	const hash = createHash("sha256");
	const buffer = Buffer.allocUnsafe(64 * 1024);
	const descriptor = openSync(file, "r");
	try {
		let length = readSync(descriptor, buffer);
		while (length > 0) {
			hash.update(buffer.subarray(0, length));
			length = readSync(descriptor, buffer);
		}
		return hash.digest("hex");
	} finally {
		closeSync(descriptor);
	}
}

/** Observe inputs without changing resolution, loaded bytes or transforms. */
export function nativeChatBuildInputAudit(): Plugin {
	const root = realpathSync(path.resolve(import.meta.dirname, "../../../.."));
	const capture = process.env.RYU_CHAT_SOURCE_RECEIPT;
	const output = process.env.RYU_CHAT_BUILD_INPUT_RECEIPT;
	if (!(capture && output)) {
		throw new Error(
			"Native Chat audit requires explicit fresh source and input receipt paths"
		);
	}
	if (existsSync(output)) {
		throw new Error("Preserve the existing native Chat input audit receipt");
	}
	const rawCapture = readFileSync(capture);
	const decoded: unknown = JSON.parse(rawCapture.toString());
	if (
		!decoded ||
		typeof decoded !== "object" ||
		!Reflect.has(decoded, "sourceSha256")
	) {
		throw new Error("Missing native Chat prebuild source hashes");
	}
	const rawHashes: unknown = Reflect.get(decoded, "sourceSha256");
	if (!rawHashes || typeof rawHashes !== "object" || Array.isArray(rawHashes)) {
		throw new Error("Invalid native Chat prebuild source hashes");
	}
	const expected = new Map<string, string>();
	for (const [file, hash] of Object.entries(rawHashes)) {
		if (typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash)) {
			throw new Error("Invalid native Chat source hash");
		}
		expected.set(realpathSync(path.resolve(root, file)), hash);
	}
	const physical = new Map<
		string,
		{ sha256: string; freeze: "prebuild" | "first-observation" }
	>();
	const nonPhysical = new Set<string>();
	let validated = false;
	function observe(id: string) {
		const file = id.startsWith("\0")
			? null
			: id.split("?")[0]?.replace(/^\/@fs\//, "/");
		if (
			!(
				file &&
				path.isAbsolute(file) &&
				existsSync(file) &&
				statSync(file).isFile()
			)
		) {
			nonPhysical.add(id);
			return;
		}
		const resolved = realpathSync(file);
		const sha256 = hashFile(resolved);
		const frozen = expected.get(resolved);
		const dependency = resolved.split(path.sep).includes("node_modules");
		if (!dependency && resolved.startsWith(`${root}${path.sep}`) && !frozen) {
			throw new Error(`Uncaptured physical workspace build input: ${resolved}`);
		}
		if (
			(frozen && frozen !== sha256) ||
			(physical.has(resolved) && physical.get(resolved)?.sha256 !== sha256)
		) {
			throw new Error(`Changed physical build input: ${resolved}`);
		}
		physical.set(resolved, {
			sha256,
			freeze: frozen ? "prebuild" : "first-observation",
		});
	}
	function verifyPhysical() {
		if (
			hashFile(capture!) !==
			createHash("sha256").update(rawCapture).digest("hex")
		) {
			throw new Error("Native Chat source receipt changed during compilation");
		}
		for (const [file, record] of physical) {
			if (hashFile(file) !== record.sha256) {
				throw new Error(`Build input changed after observation: ${file}`);
			}
		}
	}
	return {
		name: "native-chat-physical-input-audit",
		enforce: "pre",
		load(id) {
			observe(id);
			return null;
		},
		generateBundle() {
			for (const id of this.getModuleIds()) {
				observe(id);
			}
			for (const file of this.getWatchFiles()) {
				observe(file);
			}
			verifyPhysical();
			validated = true;
		},
		closeBundle() {
			if (!validated) {
				return;
			}
			verifyPhysical();
			writeFileSync(
				output,
				`${JSON.stringify(
					{
						status: "closed",
						scope:
							"observed Rollup module and watch-file inputs; virtual IDs separately listed; no claim of implicit unregistered tool reads",
						sourceReceiptSha256: createHash("sha256")
							.update(rawCapture)
							.digest("hex"),
						physical: Object.fromEntries(
							[...physical].sort(([left], [right]) => left.localeCompare(right))
						),
						nonPhysicalIds: [...nonPhysical].sort(),
					},
					null,
					2
				)}\n`,
				{ flag: "wx" }
			);
		},
	};
}
