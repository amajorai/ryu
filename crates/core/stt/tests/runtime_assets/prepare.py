#!/usr/bin/env python3
"""Explicit, checksummed local assets for optional real voice inference proofs."""
import argparse
import concurrent.futures
import hashlib
import json
import pathlib
import shlex
import tarfile
import urllib.request


def digest_file(path, expected_size=None):
    sha = hashlib.sha256()
    git = hashlib.sha1()
    size = path.stat().st_size
    git.update(f"blob {size}\0".encode())
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            sha.update(chunk)
            git.update(chunk)
    if expected_size is not None and size != expected_size:
        raise ValueError(f"wrong asset size: {path.name}")
    return size, sha.hexdigest(), git.hexdigest()


def prepare(cache):
    manifest = json.loads(pathlib.Path(__file__).with_name("manifest.json").read_text())
    cache.mkdir(parents=True, exist_ok=True)
    items = []
    parakeet = manifest["parakeet"]
    for name, metadata in parakeet["files"].items():
        url = f"https://huggingface.co/{parakeet['repo']}/resolve/{parakeet['commit']}/{name}"
        items.append((cache / "models/speech-to-text/parakeet/parakeet-tdt-0.6b-v3-int8" / name, url, metadata))
    items.append((cache / "models/vad/silero_vad_v4.onnx", manifest["silero"]["url"], manifest["silero"]))
    items.append((cache / "onnxruntime-linux-x64-1.24.2.tgz", manifest["ort"]["archive"], manifest["ort"]))
    sample = manifest["sample"]
    items.append((cache / "transcribe-rs-0.3.11.crate", sample["crate_url"], {"sha256": sample["crate_sha256"]}))

    def verify(path, metadata):
        size, sha, git = digest_file(path, metadata.get("bytes"))
        if sha != metadata["sha256"]:
            raise ValueError(f"SHA256 mismatch: {path.name}")
        if "git_blob_sha1" in metadata and git != metadata["git_blob_sha1"]:
            raise ValueError(f"pinned Git blob mismatch: {path.name}")
        return size, sha

    def fetch(item):
        path, url, metadata = item
        path.parent.mkdir(parents=True, exist_ok=True)
        if path.exists():
            size, sha = verify(path, metadata)
        else:
            partial = path.with_name(path.name + ".partial")
            with urllib.request.urlopen(url, timeout=60) as response, partial.open("wb") as output:
                while chunk := response.read(1024 * 1024):
                    output.write(chunk)
            size, sha = verify(partial, metadata)
            partial.replace(path)
        print(f"verified {path.name}: {sha}", flush=True)
        return {"file": str(path.relative_to(cache)), "bytes": size, "sha256": sha, "source": url}

    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as executor:
        records = list(executor.map(fetch, items))
    with tarfile.open(cache / "onnxruntime-linux-x64-1.24.2.tgz") as archive:
        archive.extractall(cache, filter="data")
    with tarfile.open(cache / "transcribe-rs-0.3.11.crate") as archive:
        data = archive.extractfile(sample["member"]).read()
    if hashlib.sha256(data).hexdigest() != sample["sha256"]:
        raise ValueError("authentic speech fixture SHA256 mismatch")
    (cache / "jfk.wav").write_bytes(data)
    records.append({"file": "jfk.wav", "bytes": len(data), "sha256": sample["sha256"], "source": sample["crate_url"]})
    (cache / "verified-assets.json").write_text(json.dumps(records, indent=2) + "\n")
    library = cache / "onnxruntime-linux-x64-1.24.2/lib"
    (cache / "env.sh").write_text(
        f"export RYU_VOICE_PROOF_DIR={shlex.quote(str(cache))}\n"
        f"export ORT_LIB_PATH={shlex.quote(str(library))}\n"
        "export ORT_PREFER_DYNAMIC_LINK=1\nexport ORT_SKIP_DOWNLOAD=1\n"
        f"export LD_LIBRARY_PATH={shlex.quote(str(library))}:\"${{LD_LIBRARY_PATH:-}}\"\n"
    )
    print(f"Prepared genuine local assets; source {cache / 'env.sh'} before the explicit proof commands.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache", type=pathlib.Path, default=pathlib.Path(__file__).resolve().parents[5] / "target/voice-runtime-proof-assets")
    prepare(parser.parse_args().cache.resolve())
