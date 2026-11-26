#!/usr/bin/env node
// .github/scripts/assert-glibc-ceiling.mjs
//
// Fails when a Linux binary needs a newer glibc than the place it will run in.
//
// A binary linked on a runner records, per shared library, the newest symbol
// version it was bound to. The dynamic loader refuses to start it wherever that
// version is missing. That is what happened on 26 Nov 2026: `ubuntu-latest`
// moved from Ubuntu 24.04 (glibc 2.39) to 26.04 (glibc 2.43), ryu-core was
// bound to `libm.so.6` GLIBC_2.43, and the image based on debian:trixie-slim
// (glibc 2.41) exited at start with
//
//   ryu-core: /lib/x86_64-linux-gnu/libm.so.6: version `GLIBC_2.43' not found
//
// The same day's canary published a `ryu-core-linux-x86_64` asset with the
// same requirement. Running the binary on the runner that built it proves
// nothing, since that runner has the new glibc. So the requirement itself is
// read out of the file and compared with a ceiling the workflow states.
//
// Usage, from the repository root:
//
//   node .github/scripts/assert-glibc-ceiling.mjs <ceiling> <binary>...
//
// <ceiling> is a glibc version such as 2.41. Every binary must be a 64-bit
// little-endian ELF file with a version requirement table (.gnu.version_r),
// which every dynamically linked Linux build of ours has. A file without one
// fails the step: the check must not pass because it could not read its input.

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";

const ELF_MAGIC = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);
const ELF_CLASS_64 = 2;
const ELF_DATA_LITTLE_ENDIAN = 1;
const SECTION_GNU_VERNEED = 0x6f_ff_ff_fe;
const GLIBC_VERSION = /^GLIBC_(\d+(?:\.\d+)+)$/;
const CEILING = /^\d+(?:\.\d+)+$/;

function text(file, at) {
	const end = file.indexOf(0, at);
	return file.toString("latin1", at, end === -1 ? file.length : end);
}

/**
 * Every version requirement of an ELF file: one entry per library and symbol
 * version, as `objdump -p` lists them under "Version References".
 */
export function versionNeeds(file) {
	if (file.length < 64 || !file.subarray(0, 4).equals(ELF_MAGIC)) {
		throw new Error("not an ELF file");
	}
	if (file[4] !== ELF_CLASS_64 || file[5] !== ELF_DATA_LITTLE_ENDIAN) {
		throw new Error("not a 64-bit little-endian ELF file");
	}
	const tableOffset = Number(file.readBigUInt64LE(0x28));
	const entrySize = file.readUInt16LE(0x3a);
	const entryCount = file.readUInt16LE(0x3c);
	const sections = [];
	for (let index = 0; index < entryCount; index += 1) {
		const base = tableOffset + index * entrySize;
		sections.push({
			type: file.readUInt32LE(base + 4),
			offset: Number(file.readBigUInt64LE(base + 24)),
			link: file.readUInt32LE(base + 40),
			info: file.readUInt32LE(base + 44),
		});
	}
	const needs = [];
	for (const section of sections) {
		if (section.type !== SECTION_GNU_VERNEED) {
			continue;
		}
		const strings = sections[section.link].offset;
		let entry = section.offset;
		for (let seen = 0; seen < section.info; seen += 1) {
			const auxCount = file.readUInt16LE(entry + 2);
			const library = text(file, strings + file.readUInt32LE(entry + 4));
			let aux = entry + file.readUInt32LE(entry + 8);
			for (let auxSeen = 0; auxSeen < auxCount; auxSeen += 1) {
				needs.push({
					library,
					version: text(file, strings + file.readUInt32LE(aux + 8)),
				});
				const nextAux = file.readUInt32LE(aux + 12);
				if (nextAux === 0) {
					break;
				}
				aux += nextAux;
			}
			const nextEntry = file.readUInt32LE(entry + 12);
			if (nextEntry === 0) {
				break;
			}
			entry += nextEntry;
		}
	}
	return needs;
}

/** Negative when `left` is older than `right`, zero when they are equal. */
export function compareVersions(left, right) {
	const a = left.split(".").map(Number);
	const b = right.split(".").map(Number);
	for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
		const difference = (a[index] ?? 0) - (b[index] ?? 0);
		if (difference !== 0) {
			return difference;
		}
	}
	return 0;
}

/**
 * Grades one file against the ceiling: the newest glibc version it needs and
 * each requirement above the ceiling.
 */
export function gradeBinary(file, ceiling) {
	const glibc = [];
	for (const need of versionNeeds(file)) {
		const match = GLIBC_VERSION.exec(need.version);
		if (match) {
			glibc.push({ library: need.library, version: match[1] });
		}
	}
	if (glibc.length === 0) {
		throw new Error(
			"no glibc version requirement found, so this check cannot grade the file"
		);
	}
	let highest = glibc[0].version;
	for (const need of glibc) {
		if (compareVersions(need.version, highest) > 0) {
			highest = need.version;
		}
	}
	const above = glibc.filter(
		(need) => compareVersions(need.version, ceiling) > 0
	);
	return { highest, above };
}

function main(argv) {
	const [ceiling, ...paths] = argv;
	if (!(ceiling && CEILING.test(ceiling)) || paths.length === 0) {
		console.error(
			"usage: node .github/scripts/assert-glibc-ceiling.mjs <ceiling> <binary>..."
		);
		return 2;
	}
	let failed = false;
	for (const path of paths) {
		const name = basename(path);
		let grade;
		try {
			grade = gradeBinary(readFileSync(path), ceiling);
		} catch (error) {
			console.log(
				`::error::${name}: ${error.message}. Fix the check rather than deleting it.`
			);
			failed = true;
			continue;
		}
		if (grade.above.length === 0) {
			console.log(
				`${name} needs glibc up to ${grade.highest}, ceiling ${ceiling}`
			);
			continue;
		}
		const list = grade.above
			.map((need) => `${need.library} GLIBC_${need.version}`)
			.join(", ");
		console.log(
			`::error::${name} needs glibc ${grade.highest} but must start on glibc ${ceiling} (${list}). It was linked on a runner whose glibc is newer than the place it runs in. Build it on an older fixed runner label; do not raise the ceiling unless the runtime really moved.`
		);
		failed = true;
	}
	return failed ? 1 : 0;
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	process.exit(main(process.argv.slice(2)));
}
