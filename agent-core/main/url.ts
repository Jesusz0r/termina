/**
 * Outbound URL policy for fetch and MCP HTTP.
 * https-only, test-only http loopback, and blocked special-use hosts.
 * Parse-time checks stay literal and offline. Resolve-at-connect is a
 * separate hop check so MCP config parse never touches the network.
 */
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

const HOST_NOT_ALLOWED = "error: URL host not allowed";

const restricted = new BlockList();
restricted.addSubnet("0.0.0.0", 8, "ipv4");
restricted.addSubnet("10.0.0.0", 8, "ipv4");
restricted.addSubnet("100.64.0.0", 10, "ipv4");
restricted.addSubnet("127.0.0.0", 8, "ipv4");
restricted.addSubnet("169.254.0.0", 16, "ipv4");
restricted.addSubnet("172.16.0.0", 12, "ipv4");
restricted.addSubnet("192.168.0.0", 16, "ipv4");
restricted.addSubnet("224.0.0.0", 4, "ipv4");
restricted.addAddress("::", "ipv6");
restricted.addAddress("::1", "ipv6");
restricted.addSubnet("fc00::", 7, "ipv6");
restricted.addSubnet("fe80::", 10, "ipv6");
restricted.addSubnet("ff00::", 8, "ipv6");
restricted.addSubnet("::ffff:0.0.0.0", 104, "ipv6");
restricted.addSubnet("::ffff:10.0.0.0", 104, "ipv6");
restricted.addSubnet("::ffff:100.64.0.0", 106, "ipv6");
restricted.addSubnet("::ffff:127.0.0.0", 104, "ipv6");
restricted.addSubnet("::ffff:169.254.0.0", 112, "ipv6");
restricted.addSubnet("::ffff:172.16.0.0", 108, "ipv6");
restricted.addSubnet("::ffff:192.168.0.0", 112, "ipv6");
restricted.addSubnet("::ffff:224.0.0.0", 100, "ipv6");

function normalizeHost(hostname: string): string {
  let host = hostname.trim().toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  const zone = host.indexOf("%");
  if (zone !== -1) host = host.slice(0, zone);
  return host.replace(/\.+$/, "");
}

function isTestLoopbackHost(hostname: string): boolean {
  const host = normalizeHost(hostname);
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

function restrictedNetworkHost(hostname: string): boolean {
  const host = normalizeHost(hostname);
  if (!host || host === "localhost" || host.endsWith(".localhost")) return true;
  if (isIP(host) === 4) return restricted.check(host, "ipv4");
  if (isIP(host) === 6) return restricted.check(host, "ipv6");
  return false;
}

export function outboundUrlError(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "error: invalid URL";
  }
  if (parsed.protocol === "http:" && isTestLoopbackHost(parsed.hostname) && process.env.TERMINA_CORE_TEST === "1") {
    return null;
  }
  if (parsed.protocol === "https:") {
    return restrictedNetworkHost(parsed.hostname) ? HOST_NOT_ALLOWED : null;
  }
  if (parsed.protocol === "http:") return "error: only https URLs are allowed";
  return `error: URL scheme not allowed: ${parsed.protocol}`;
}

/**
 * Resolve a hostname just before connect. Literal IPs and test-only
 * loopback skip the network. A name that answers with any restricted
 * address fails closed. Lookup failure is not treated as private: the
 * hop still has to survive fetch/connect.
 */
export async function resolvedHostError(hostname: string): Promise<string | null> {
  if (process.env.TERMINA_CORE_TEST === "1" && isTestLoopbackHost(hostname)) return null;
  const host = normalizeHost(hostname);
  if (!host) return HOST_NOT_ALLOWED;
  if (restrictedNetworkHost(host)) return HOST_NOT_ALLOWED;
  if (isIP(host)) return null;
  try {
    const answers = await lookup(host, { all: true });
    if (answers.length === 0) return null;
    for (const answer of answers) {
      if (restrictedNetworkHost(answer.address)) return HOST_NOT_ALLOWED;
    }
    return null;
  } catch {
    return null;
  }
}
