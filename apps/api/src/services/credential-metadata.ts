import { normalizeCredentialHosts, type CredentialRecord } from "@trusty-squire/vault";

export type HostListEdit = {
  mode: "add" | "remove" | "replace";
  hosts: string[];
};

export interface CredentialMetadataChanges {
  label?: string;
  allowed_hosts?: HostListEdit;
  login_hosts?: HostListEdit;
}

export interface CredentialMutationMetadata {
  label: string;
  allowed_hosts: string[];
  login_hosts: string[];
  auth_strategy: string | null;
}

function applyListEdit(current: readonly string[], edit: HostListEdit, hosts: string[]): string[] {
  if (edit.mode === "replace") return hosts;
  if (edit.mode === "add") return [...current, ...hosts.filter((host) => !current.includes(host))];
  const removed = new Set(hosts);
  return current.filter((host) => !removed.has(host));
}

export function editableMetadata(record: CredentialRecord): CredentialMutationMetadata {
  const loginHosts = Array.isArray(record.metadata.login_hosts)
    ? record.metadata.login_hosts.filter((value): value is string => typeof value === "string")
    : [];
  return {
    label: record.label,
    allowed_hosts: [...record.allowed_hosts],
    login_hosts: loginHosts,
    auth_strategy:
      typeof record.metadata.auth_strategy === "string" ? record.metadata.auth_strategy : null,
  };
}

export function applyCredentialMetadataChanges(
  before: CredentialMutationMetadata,
  changes: CredentialMetadataChanges,
):
  | CredentialMutationMetadata
  | { error: "invalid_allowed_host" | "invalid_login_host" | "login_hosts_required" } {
  let allowedHosts = before.allowed_hosts;
  if (changes.allowed_hosts !== undefined) {
    const normalized = normalizeCredentialHosts(changes.allowed_hosts.hosts, "allowed") ?? [];
    allowedHosts = applyListEdit(before.allowed_hosts, changes.allowed_hosts, normalized);
  }
  let loginHosts = before.login_hosts;
  if (changes.login_hosts !== undefined) {
    const normalized = normalizeCredentialHosts(changes.login_hosts.hosts, "login");
    if (normalized === null) return { error: "invalid_login_host" };
    loginHosts = applyListEdit(before.login_hosts, changes.login_hosts, normalized);
  }
  const authStrategy =
    changes.login_hosts !== undefined && loginHosts.length > 0
      ? "username_password"
      : before.auth_strategy;
  if (authStrategy === "username_password" && loginHosts.length === 0) {
    return { error: "login_hosts_required" };
  }
  return {
    label: changes.label?.trim() ?? before.label,
    allowed_hosts: allowedHosts,
    login_hosts: loginHosts,
    auth_strategy: authStrategy,
  };
}
