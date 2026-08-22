import type { CredentialRecord, VaultEditableMetadata } from "@trusty-squire/vault";

export type HostListEdit = {
  mode: "add" | "remove" | "replace";
  hosts: string[];
};

export interface CredentialMetadataChanges {
  label?: string;
  allowed_hosts?: HostListEdit;
  login_hosts?: HostListEdit;
}

const TWO_LABEL_PUBLIC_SUFFIXES: ReadonlySet<string> = new Set([
  "co.uk",
  "org.uk",
  "gov.uk",
  "ac.uk",
  "com.au",
  "net.au",
  "org.au",
  "co.jp",
  "co.nz",
  "co.in",
  "com.br",
  "co.za",
  "com.cn",
  "github.io",
  "web.app",
  "firebaseapp.com",
  "pages.dev",
  "workers.dev",
  "vercel.app",
  "netlify.app",
  "herokuapp.com",
]);

export function normalizeHost(raw: string): string | null {
  let host = raw.trim().toLowerCase();
  if (host.length === 0) return null;
  host = host.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  host = host.replace(/[/?#].*$/, "");
  host = host.replace(/:\d+$/, "");
  if (host.length === 0 || /\s/.test(host) || !/^[a-z0-9.-]+$/.test(host)) return null;
  return host;
}

function validLoginHost(host: string): boolean {
  if (host.includes("..") || host.startsWith(".") || host.endsWith(".")) return false;
  if (host.includes("xn--") || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return false;
  const labels = host.split(".");
  return (
    labels.length >= 2 &&
    labels.every((label) => label.length > 0 && label.length <= 63) &&
    !TWO_LABEL_PUBLIC_SUFFIXES.has(host)
  );
}

function normalizeLoginHost(raw: string): string | null {
  const trimmed = raw.trim().toLowerCase();
  if (trimmed.startsWith("*.")) {
    const suffix = normalizeHost(trimmed.slice(2));
    return suffix !== null && validLoginHost(suffix) ? `*.${suffix}` : null;
  }
  const host = normalizeHost(trimmed);
  return host !== null && validLoginHost(host) ? host : null;
}

function normalizeHosts(
  raw: readonly string[],
  normalize: (value: string) => string | null,
): string[] | null {
  const result: string[] = [];
  for (const value of raw) {
    const host = normalize(value);
    if (host === null) return null;
    if (!result.includes(host)) result.push(host);
  }
  return result;
}

function applyListEdit(current: readonly string[], edit: HostListEdit, hosts: string[]): string[] {
  if (edit.mode === "replace") return hosts;
  if (edit.mode === "add") return [...current, ...hosts.filter((host) => !current.includes(host))];
  const removed = new Set(hosts);
  return current.filter((host) => !removed.has(host));
}

export function editableMetadata(record: CredentialRecord): VaultEditableMetadata {
  const loginHosts = Array.isArray(record.metadata.login_hosts)
    ? record.metadata.login_hosts.filter((value): value is string => typeof value === "string")
    : [];
  return {
    label: record.label,
    allowed_hosts: [...record.allowed_hosts],
    login_hosts: loginHosts,
  };
}

export function applyCredentialMetadataChanges(
  before: VaultEditableMetadata,
  changes: CredentialMetadataChanges,
): VaultEditableMetadata | { error: "invalid_allowed_host" | "invalid_login_host" } {
  let allowedHosts = before.allowed_hosts;
  if (changes.allowed_hosts !== undefined) {
    const normalized = normalizeHosts(changes.allowed_hosts.hosts, normalizeHost);
    if (normalized === null) return { error: "invalid_allowed_host" };
    allowedHosts = applyListEdit(before.allowed_hosts, changes.allowed_hosts, normalized);
  }
  let loginHosts = before.login_hosts;
  if (changes.login_hosts !== undefined) {
    const normalized = normalizeHosts(changes.login_hosts.hosts, normalizeLoginHost);
    if (normalized === null) return { error: "invalid_login_host" };
    loginHosts = applyListEdit(before.login_hosts, changes.login_hosts, normalized);
  }
  return {
    label: changes.label?.trim() ?? before.label,
    allowed_hosts: allowedHosts,
    login_hosts: loginHosts,
  };
}
