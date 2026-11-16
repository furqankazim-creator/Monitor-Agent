import dns from 'node:dns';
import net from 'node:net';
import { config } from './config.js';

// Targets this platform may NOT probe unless the operator opts in (ALLOW_PRIVATE_TARGETS / ALLOWED_HOSTS).
const bl = new net.BlockList();
for (const [a, p] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4]]) bl.addSubnet(a, p, 'ipv4');
for (const [a, p] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]]) bl.addSubnet(a, p, 'ipv6');

export function isPrivateIp(ip) {
  let a = ip.replace(/^\[|\]$/g, '');
  if (a.toLowerCase().startsWith('::ffff:') && net.isIPv4(a.slice(7))) a = a.slice(7);
  const fam = net.isIPv4(a) ? 'ipv4' : net.isIPv6(a) ? 'ipv6' : null;
  if (!fam) return true;
  return bl.check(a, fam);
}
export const hostAllowed = (host) => config.allowedHosts.includes(String(host).toLowerCase());

/** Node never calls `lookup` for IP-literal hosts, so literals (incl. redirect hops) must be checked explicitly. */
export function guardLiteral(host) {
  const h = String(host).replace(/^\[|\]$/g, '');
  if (net.isIP(h) && !(config.allowPrivateTargets || hostAllowed(h)) && isPrivateIp(h)) {
    const e = new Error(`Target ${h} is a private/internal address; blocked by SSRF policy`); e.code = 'ESSRF'; throw e;
  }
}

// Used as the `lookup` option of http/https/tls/net so the IP actually dialled is the one validated (defeats DNS rebinding).
export function guardedLookup(hostname, options, cb) {
  if (typeof options === 'function') { cb = options; options = {}; }
  dns.lookup(hostname, { ...options, all: true }, (err, addrs) => {
    if (err) return cb(err);
    if (!(config.allowPrivateTargets || hostAllowed(hostname))) {
      const bad = addrs.find((x) => isPrivateIp(x.address));
      if (bad) { const e = new Error(`Target ${hostname} resolves to a private/internal address (${bad.address}); blocked by SSRF policy`); e.code = 'ESSRF'; return cb(e); }
    }
    if (options && options.all) return cb(null, addrs);
    cb(null, addrs[0].address, addrs[0].family);
  });
}

// Registration-time validation: scheme + literal IPs + resolution.
export async function assertTargetAllowed(urlOrHost) {
  let host = urlOrHost;
  if (/^[a-z]+:\/\//i.test(urlOrHost)) {
    const u = new URL(urlOrHost);
    if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Only http and https URLs are allowed');
    if (u.username || u.password) throw new Error('Credentials in URLs are not allowed; use the authentication settings');
    host = u.hostname;
  }
  host = host.replace(/^\[|\]$/g, '');
  if (config.allowPrivateTargets || hostAllowed(host)) return true;
  if (net.isIP(host)) { if (isPrivateIp(host)) throw new Error(`${host} is a private/internal address (blocked by SSRF policy)`); return true; }
  try {
    const addrs = await dns.promises.lookup(host, { all: true });
    const bad = addrs.find((a) => isPrivateIp(a.address));
    if (bad) throw new Error(`${host} resolves to private address ${bad.address} (blocked by SSRF policy)`);
  } catch (e) { if (e.code === 'ENOTFOUND') return true; /* allow registering not-yet-live DNS; checks will report it */ throw e; }
  return true;
}
