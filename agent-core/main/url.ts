/**
 * Outbound URL policy for fetch and MCP HTTP.
 * https-only, test-only http loopback, and blocked special-use hosts.
 * Parse-time checks stay literal and offline. Resolve-at-connect is a
 * separate hop check so MCP config parse never touches the network.
 *
 * One resolver contract (#158, #159): the precheck (resolvedHostError) and
 * the dial-path lookup (createValidatedLookup) share the address rule and
 * the test-loopback bypass. The precheck rejects early under the operation
 * deadline; the dial path re-validates the answers the socket actually uses,
 * so a rebinding hostname cannot slip a private address between the two.
 * Validation never substitutes addresses or touches TLS: SNI and hostname
 * verification still see the original hostname.
 */
import { lookup as callbackLookup, type LookupAddress, type LookupOptions } from "node:dns";
import { lookup as promisesLookup } from "node:dns/promises";
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
 * address fails closed, as do lookup failures and empty answers: there is
 * nothing safe to connect to. An aborted signal fails without resolving or
 * waiting for a late answer; callers map the abort to interrupted/timed-out.
 */
export async function resolvedHostError(
  hostname: string,
  opts?: { signal?: AbortSignal; lookup?: (host: string) => Promise<readonly LookupAddress[]> },
): Promise<string | null> {
  if (process.env.TERMINA_CORE_TEST === "1" && isTestLoopbackHost(hostname)) return null;
  const host = normalizeHost(hostname);
  if (!host) return HOST_NOT_ALLOWED;
  if (restrictedNetworkHost(host)) return HOST_NOT_ALLOWED;
  if (isIP(host)) return null;
  if (opts?.signal?.aborted) return dnsAbortMessage(opts.signal);
  const lookup = opts?.lookup ?? ((name: string) => promisesLookup(name, { all: true }));
  let answers: readonly LookupAddress[];
  try {
    answers = await raceSignal(lookup(host), opts?.signal);
  } catch (err) {
    if (isDnsAbort(err)) return dnsAbortMessage(opts?.signal);
    return unresolvableError(host);
  }
  if (answers.length === 0) return unresolvableError(host);
  for (const answer of answers) {
    if (restrictedNetworkHost(answer.address)) return HOST_NOT_ALLOWED;
  }
  return null;
}

/** Abort sentinel: already-aborted callers map it to interrupted/timed-out. */
export const DNS_LOOKUP_ABORTED = "error: DNS lookup aborted";
export const DNS_LOOKUP_TIMED_OUT = "error: DNS lookup timed out";

function dnsAbortMessage(signal?: AbortSignal): string {
  const reason = signal?.reason as { name?: unknown } | undefined;
  return reason?.name === "TimeoutError" ? DNS_LOOKUP_TIMED_OUT : DNS_LOOKUP_ABORTED;
}

function unresolvableError(host: string): string {
  const display = host.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").slice(0, 128) || "(invalid host)";
  return `error: could not resolve ${display}`;
}

class DnsAbort extends Error {
  constructor() {
    super("DNS lookup aborted");
    this.name = "DnsAbort";
  }
}

function isDnsAbort(err: unknown): boolean {
  return err instanceof DnsAbort;
}

/** Race a lookup against an abort signal; late completion is safely ignored. */
function raceSignal<T>(task: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal || signal.aborted) return task;
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener("abort", onAbort);
      reject(new DnsAbort());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    task.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

export type CallbackDnsLookup = (
  hostname: string,
  options: LookupOptions,
  callback: (err: Error | null, addresses: LookupAddress[] | string, family?: number) => void,
) => void;

function validatedAddresses(host: string, answers: readonly LookupAddress[]): string | null {
  if (answers.length === 0) return `no addresses for ${host}`;
  for (const answer of answers) {
    if (restrictedNetworkHost(answer.address)) return "URL host not allowed";
  }
  return null;
}

/**
 * Dial-path lookup for http(s) transports (#158). Resolves fresh on every
 * connection (never pinned), validates the full answer set the socket will
 * use, and fails closed on restricted, empty, or failed lookups. Literal and
 * test-loopback handling mirrors the precheck. TLS is untouched: only name
 * resolution is wrapped, never SNI or certificate verification.
 */
export function createValidatedLookup(dnsImpl: CallbackDnsLookup = callbackLookup): CallbackDnsLookup {
  return (hostname, options, callback) => {
    if (process.env.TERMINA_CORE_TEST === "1" && isTestLoopbackHost(hostname)) {
      dnsImpl(hostname, options, callback);
      return;
    }
    const host = normalizeHost(hostname);
    if (!host || restrictedNetworkHost(host)) {
      callback(new Error("URL host not allowed"), "", 0);
      return;
    }
    // Always resolve the full set: undici-style happy eyeballs may dial any
    // answered address, so validating only the first would leave a gap.
    dnsImpl(hostname, { ...options, all: true }, (err, answers) => {
      if (err) {
        callback(err, "", 0);
        return;
      }
      const list = (Array.isArray(answers) ? answers : []) as LookupAddress[];
      const blocked = validatedAddresses(host, list);
      if (blocked) {
        callback(new Error(blocked), "", 0);
        return;
      }
      if ((options as { all?: unknown }).all === true) callback(null, list);
      else callback(null, list[0]!.address, list[0]!.family);
    });
  };
}

/** AbortError-shaped rejection so callers map DNS aborts like fetch aborts. */
export function dnsAbortError(): Error {
  return Object.assign(new Error("DNS lookup aborted"), { name: "AbortError" });
}
