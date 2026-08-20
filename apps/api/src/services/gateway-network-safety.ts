/** SSRF guard for operator-configured OpenAI-compatible/NewAPI endpoints. */
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

/*
 * IPv4 与 IPv6 的判据必须分开持有。
 *
 * 下面 IPv6 表里的 `::ffff:0:0/96` 是 IPv4-mapped 段，它存在的意义是不让
 * `::ffff:10.0.0.5` 这种写法绕过 IPv4 私网判定。但 Node 的 BlockList 会把这条
 * 规则同样应用到 `check(addr, "ipv4")` 上——两张表放进同一个 BlockList 时，
 * **每一个 IPv4 地址都命中**，`isNonPublicIp` 恒为真：
 *
 *   const b = new BlockList(); b.addSubnet("::ffff:0:0", 96, "ipv6");
 *   b.check("8.8.8.8", "ipv4")  // → true
 *
 * 实测后果（2026-08-06）：生产模式下任何 IPv4 网关都被拒，连
 * https://api.openai.com/v1 也要求列进 LLM_GATEWAY_ALLOWED_HOSTS。这道防线
 * 一直是「全拒」，只是以前没人在 NODE_ENV=production 下走到这里。
 * 契约见 apps/api/test/gateway-network-safety.test.ts。
 */
const NON_PUBLIC_IPV4 = new BlockList();
const NON_PUBLIC_IPV6 = new BlockList();

for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 3],
] as const) {
  NON_PUBLIC_IPV4.addSubnet(network, prefix, "ipv4");
}

for (const [network, prefix] of [
  ["::", 96],
  ["::ffff:0:0", 96],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 32],
  ["2001:2::", 48],
  ["2001:10::", 28],
  ["2001:20::", 28],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
] as const) {
  NON_PUBLIC_IPV6.addSubnet(network, prefix, "ipv6");
}

function withoutIpv6Brackets(address: string): string {
  return address.startsWith("[") && address.endsWith("]")
    ? address.slice(1, -1)
    : address;
}

function isNonPublicIp(address: string): boolean {
  const normalized = withoutIpv6Brackets(address).toLowerCase();
  const family = isIP(normalized);
  if (family === 4) return NON_PUBLIC_IPV4.check(normalized, "ipv4");
  if (family === 6) {
    // IPv4-mapped（::ffff:a.b.c.d）先按它真正代表的 IPv4 判一次，否则
    // `::ffff:10.0.0.5` 会绕过 IPv4 私网表。
    const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/u)?.[1];
    if (mapped && NON_PUBLIC_IPV4.check(mapped, "ipv4")) return true;
    return NON_PUBLIC_IPV6.check(normalized, "ipv6");
  }
  return true;
}

function allowedPrivateHost(hostname: string, host: string): boolean {
  if (process.env.NODE_ENV !== "production") return true;
  const allow = new Set(
    (process.env.LLM_GATEWAY_ALLOWED_HOSTS ?? "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
  return allow.has(hostname.toLowerCase()) || allow.has(host.toLowerCase());
}

export async function assertSafeGatewayBaseUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("gateway base URL is invalid");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("gateway base URL must use http or https");
  }
  if (url.username || url.password || url.hash || url.search) {
    throw new Error(
      "gateway base URL must not contain credentials, fragments, or query parameters",
    );
  }
  if (
    url.protocol === "http:" &&
    process.env.NODE_ENV === "production" &&
    process.env.LLM_ALLOW_INSECURE_GATEWAYS !== "true"
  ) {
    throw new Error("production gateway endpoints must use https");
  }

  const hostname = withoutIpv6Brackets(url.hostname).toLowerCase();
  const addresses = isIP(hostname)
    ? [{ address: hostname }]
    : await lookup(hostname, { all: true, verbatim: true });
  if (addresses.length === 0) throw new Error("gateway host did not resolve");
  if (
    addresses.some((entry) => isNonPublicIp(entry.address)) &&
    !allowedPrivateHost(hostname, url.host)
  ) {
    throw new Error(
      "private gateway hosts require an explicit LLM_GATEWAY_ALLOWED_HOSTS entry",
    );
  }
  return url;
}

export function gatewayApiUrl(
  baseUrl: string,
  path: "/models" | "/chat/completions" | "/responses",
  ensureV1 = false,
): string {
  const url = new URL(baseUrl);
  let basePath = url.pathname.replace(/\/+$/, "");
  if (ensureV1 && !basePath.endsWith("/v1")) basePath = `${basePath}/v1`;
  url.pathname = `${basePath}${path}`.replace(/\/{2,}/g, "/");
  return url.toString();
}
