// Image and runtime assets for `ryu secrets run --broker … --isolation=container`.
//
// The Dockerfile and the firewall script are shipped inside the CLI and sent
// to `docker build` as a tar context on stdin, so no files are unpacked on
// the host. Their content hash names the trusted image
// (`ryu-vault-isolation:<hash>`), so a CLI with changed assets rebuilds on
// first use. The base image is pinned by digest, so the hashed Dockerfile
// text identifies every byte that runs as root.
//
// Trust path (all before the command runs):
//   1. A network-owner container from the trusted image joins the per-run
//      network with only NET_ADMIN and NET_RAW and sleeps.
//   2. `docker exec` runs `ryu-init-firewall.sh` inside it: INPUT and OUTPUT
//      default to DROP; output is allowed to one TCP destination (the host
//      relay, `ryu-vault-gateway:<port>`) and input only as replies from it.
//      Docker's embedded DNS resolver (127.0.0.11) is blocked, so names are
//      resolved by the broker only. All IPv6 traffic is dropped.
//   3. The command container (the trusted image, or the user's `--image`)
//      shares that network namespace (`--network container:<owner>`) with
//      every capability dropped, `no-new-privileges`, and the invoking
//      user's uid/gid, so neither it nor its image's binaries can change the
//      firewall. `RUN_SCRIPT` (bind-mounted read-only) only builds the CA
//      bundle and execs the command; it never runs with privileges.

export const ISOLATION_IMAGE_REPO = "ryu-vault-isolation";
export const FIREWALL_PATH = "/usr/local/sbin/ryu-init-firewall.sh";
/** Host name the containers use for the relay; set with `--add-host`. */
export const GATEWAY_HOST = "ryu-vault-gateway";
/** Read-only bind mount holding the broker CA and the run script. */
export const CONTAINER_RUNTIME_DIR = "/etc/ryu-vault";
export const CONTAINER_CA_PATH = `${CONTAINER_RUNTIME_DIR}/ca.pem`;
export const RUN_SCRIPT_PATH = `${CONTAINER_RUNTIME_DIR}/run.sh`;
/** Combined image + broker bundle the run script writes. */
const CONTAINER_CA_BUNDLE_DIR = "/tmp/ryu-vault";
export const CONTAINER_CA_BUNDLE_PATH = `${CONTAINER_CA_BUNDLE_DIR}/ca-bundle.pem`;
/** `debian:bookworm-slim` multi-arch index, pinned. Bump deliberately. */
export const BASE_IMAGE =
	"debian:bookworm-slim@sha256:7c7b2c966bc9ee8cedfeef67e0e279108992c77681fa595db4a9d65c06ccc587";

export const FIREWALL_SCRIPT = `#!/bin/sh
# Ryu secret vault isolation: default-deny traffic except the broker relay.
# Runs in the trusted network-owner container. The relay host comes from
# /etc/hosts (docker run --add-host), so no DNS rule exists, and Docker's
# embedded resolver on 127.0.0.11 is blocked. Only connections the
# container opens to the relay are allowed; nothing can connect in.
set -eu

fail() {
  echo "ryu-vault firewall: $*" >&2
  exit 1
}

port="\${RYU_VAULT_FORWARD_PORT:-}"
case "$port" in
  '' | *[!0-9]*) fail "RYU_VAULT_FORWARD_PORT is not a port number" ;;
esac

set -- $(getent ahostsv4 ${GATEWAY_HOST} || true)
gateway="\${1:-}"
case "$gateway" in
  '' ) fail "${GATEWAY_HOST} has no IPv4 address (missing --add-host?)" ;;
  *[!0-9.]* ) fail "gateway $gateway is not an IPv4 literal" ;;
esac

iptables -P INPUT DROP
iptables -P OUTPUT DROP
iptables -P FORWARD DROP
iptables -F INPUT
iptables -F OUTPUT
iptables -F FORWARD
iptables -A OUTPUT -d 127.0.0.11 -j DROP
iptables -A OUTPUT -o lo -j ACCEPT
iptables -A OUTPUT -d "$gateway" -p tcp --dport "$port" -j ACCEPT
iptables -A INPUT -i lo -j ACCEPT
iptables -A INPUT -s "$gateway" -p tcp --sport "$port" -m conntrack --ctstate ESTABLISHED -j ACCEPT

if command -v ip6tables >/dev/null 2>&1 && ip6tables -S OUTPUT >/dev/null 2>&1; then
  ip6tables -P INPUT DROP
  ip6tables -P OUTPUT DROP
  ip6tables -P FORWARD DROP
  ip6tables -F INPUT
  ip6tables -F OUTPUT
  ip6tables -F FORWARD
  ip6tables -A INPUT -i lo -j ACCEPT
  ip6tables -A OUTPUT -o lo -j ACCEPT
elif [ -s /proc/net/if_inet6 ] && grep -qv ' lo$' /proc/net/if_inet6; then
  fail "IPv6 is enabled but ip6tables is unavailable"
fi

echo "ryu-vault: traffic limited to $gateway:$port" >&2
`;

/** Bind-mounted at `RUN_SCRIPT_PATH` and run by the image's `/bin/sh` as the
 *  unprivileged command user. It holds no secret and no privilege. */
export const RUN_SCRIPT = `#!/bin/sh
# Ryu secret vault isolation: builds the CA bundle, then runs the command.
# Runs as the invoking user with no capabilities; the firewall is already
# in place in the shared network namespace.
set -eu

fail() {
  echo "ryu-vault: $*" >&2
  exit 126
}

[ "$#" -gt 0 ] || fail "no command given"
mkdir -p ${CONTAINER_CA_BUNDLE_DIR} "\${HOME:-/tmp/home}" || fail "cannot write /tmp"
system_bundle=""
for candidate in /etc/ssl/certs/ca-certificates.crt /etc/pki/tls/certs/ca-bundle.crt /etc/ssl/cert.pem; do
  if [ -r "$candidate" ]; then
    system_bundle="$candidate"
    break
  fi
done
{
  if [ -n "$system_bundle" ]; then
    cat "$system_bundle"
    echo
  fi
  cat ${CONTAINER_CA_PATH}
} >${CONTAINER_CA_BUNDLE_PATH} || fail "cannot write the CA bundle"
exec "$@"
`;

export const DEFAULT_DOCKERFILE = `# Ryu secret vault isolation image, built locally on first use.
FROM ${BASE_IMAGE}
RUN apt-get update \\
 && apt-get install -y --no-install-recommends ca-certificates curl git iptables \\
 && rm -rf /var/lib/apt/lists/*
COPY ryu-init-firewall.sh /usr/local/sbin/
WORKDIR /workspace
`;

export interface ContextFile {
	content: string;
	mode: number;
	name: string;
}

/** The build-context files, in the canonical (hashed) order. */
export function contextFiles(dockerfile: string): ContextFile[] {
	return [
		{ name: "Dockerfile", content: dockerfile, mode: 0o644 },
		{ name: "ryu-init-firewall.sh", content: FIREWALL_SCRIPT, mode: 0o755 },
	];
}
