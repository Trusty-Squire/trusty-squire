// The release acceptance arm uses three independent MCP stdio servers and
// an enrolled, isolated real profile. It never seeds cookies or bypasses the
// Google admission gate. Invoke the exported entrypoint directly in Node;
// configured native-host evidence is collected separately via actual MCP tools.
import assert from "node:assert/strict";
import { getDomain } from "tldts";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile, writeFile, mkdir, readdir, realpath } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { processInventory } from "./broker-process-inventory.mjs";
import {
  createFreshCredentialRun,
  FORCE_FRESH_CREDENTIAL_POLICY,
  probeThenCleanupFreshCredential,
  qualifyFreshCredentialEvidence,
  qualifyOldCredentialControl,
  reviewedCredentialProbe,
  validateReviewedCredentialProbeResponse,
} from "./fresh-credential-policy.mjs";
import { runNativeLaunchDiagnostic } from "./native-launch-diagnostics.mjs";
const script = fileURLToPath(import.meta.url);
const bin = fileURLToPath(new URL("../dist/bin.js", import.meta.url));
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const EXECUTION_STATES = new Set(["completed", "cancelled", "pending", "unknown"]);
const MUTATION_STATES = new Set(["not_dispatched", "dispatched", "unknown"]);
const CLEANUP_STATES = new Set(["open", "closing", "closed", "already_closed", "unknown"]);

export function validateClosureReceipt(receipt, sessionId) {
  assert.ok(receipt && typeof receipt === "object", "Finish closure receipt missing");
  assert.equal(receipt.session_id, sessionId, "Finish receipt session identity mismatch");
  assert.equal(typeof receipt.operation_id, "string", "Finish receipt operation identity missing");
  assert.ok(EXECUTION_STATES.has(receipt.execution), "Finish receipt execution state invalid");
  assert.ok(MUTATION_STATES.has(receipt.mutation), "Finish receipt mutation state invalid");
  assert.ok(CLEANUP_STATES.has(receipt.cleanup), "Finish receipt cleanup state invalid");
  assert.equal(typeof receipt.closed, "boolean", "Finish receipt closed flag missing");
  assert.equal(
    receipt.closed,
    receipt.cleanup === "closed" || receipt.cleanup === "already_closed",
    "Finish receipt closed flag contradicts cleanup state",
  );
  return receipt;
}

export function validateConfiguredNativeConnectionEvidence(evidence, releaseVersion) {
  assert.equal(
    evidence?.kind,
    "configured-native-host-mcp-connection",
    "Configured native-host MCP evidence missing",
  );
  assert.equal(evidence.release_version, releaseVersion, "Configured host version mismatch");
  assert.equal(typeof evidence.host_name, "string", "Configured host name missing");
  assert.equal(typeof evidence.connection_id, "string", "Configured host connection id missing");
  assert.equal(typeof evidence.observed_at, "string", "Configured host observation time missing");
  assert.equal(
    evidence.initialize?.server_version,
    releaseVersion,
    "Configured host did not initialize the release",
  );
  assert.ok(
    Array.isArray(evidence.tools_list?.names) &&
      evidence.tools_list.names.includes("operate_start"),
    "Configured host tools/list evidence missing operate_start",
  );
  assert.equal(
    evidence.read_only_probe?.name,
    "list_credentials",
    "Configured host evidence must include the bounded read-only list_credentials call",
  );
  assert.equal(
    evidence.read_only_probe?.outcome,
    "completed",
    "Configured host read-only probe failed",
  );
  return evidence;
}

async function runClient(configPath, index) {
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const configuredService = config.services[index];
  const service = configuredService.driverEvidenceFile
    ? {
        ...configuredService,
        driverEvidence: JSON.parse(
          await readFile(
            resolve(dirname(configPath), configuredService.driverEvidenceFile),
            "utf8",
          ),
        ),
      }
    : configuredService;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [bin, "server"],
    env: process.env,
    stderr: "pipe",
  });
  const client = new Client({ name: `broker-acceptance-${index}`, version: "1" });
  let sessionId;
  let call;
  const calls = [];
  try {
    await client.connect(transport);
    call = async (name, args, timeout = 20_000) => {
      const started_at = Date.now();
      try {
        const result = await client.callTool({ name, arguments: args }, undefined, { timeout });
        const text = result.content.find((item) => item.type === "text")?.text;
        assert.equal(typeof text, "string");
        const value = JSON.parse(text);
        if (result.isError) {
          const error = new Error(JSON.stringify(result.content));
          error.toolResult = value;
          throw error;
        }
        calls.push({ name, started_at, completed_at: Date.now(), outcome: "completed" });
        return value;
      } catch (error) {
        calls.push({ name, started_at, completed_at: Date.now(), outcome: "failed" });
        throw error;
      }
    };
    const initial = await call(
      "operate_start",
      {
        service_url: service.url,
        allowed_hosts: service.allowedHosts ?? [],
      },
      35_000,
    );
    assert.equal(
      initial.needs_user,
      undefined,
      "Enrolled test Google identity is required; no admission bypass is permitted",
    );
    sessionId = initial.session_id;
    assert.equal(typeof sessionId, "string");
    process.send({
      event: "ready",
      pid: process.pid,
      mcpPid: transport.pid,
      sessionId,
      broker: initial.broker,
    });
    await new Promise((r) => process.once("message", r));
    const start = Date.now();
    const run = createFreshCredentialRun(
      process.env.TRUSTY_SQUIRE_BROKER_QUALIFICATION_RUN_ID,
      index,
      config.credential_cleanup_policy,
      service.provider,
      service.providerAccountId,
      start,
    );
    const vaultBefore = await call("list_credentials", {});
    const driver = await import(pathToFileURL(resolve(dirname(configPath), service.driver)).href);
    assert.equal(
      typeof driver.captureCredentialBaseline,
      "function",
      "Driver baseline hook missing",
    );
    const providerBaseline = await driver.captureCredentialBaseline({
      call,
      sessionId,
      initial,
      run,
      service,
    });
    assert.equal(
      providerBaseline.account_id,
      run.provider_account_id,
      "Provider baseline belongs to the wrong account",
    );
    assert.ok(
      ["authenticated", "unauthenticated", "unknown"].includes(providerBaseline.initial_auth_state),
      "Provider baseline must record the initial authentication state",
    );
    const baseline = {
      provider_credential_ids: providerBaseline.provider_credential_ids,
      vault_references: (vaultBefore.credentials ?? []).map((credential) => credential.reference),
    };
    const oldControl = qualifyOldCredentialControl({
      run,
      baseline,
      control: service.oldCredentialControl,
      vaultCredentials: vaultBefore.credentials ?? [],
    });
    const oldProbeResult = await call("use_credential", {
      reference: oldControl.vault_reference,
      http: oldControl.probe.http,
    });
    validateReviewedCredentialProbeResponse(run.provider, oldProbeResult.response);
    const oldProbeCompletedAt = Date.now();
    const evidence = await driver.provision({ call, sessionId, initial, run, service });
    const vaultAfter = await call("list_credentials", {});
    const qualified = qualifyFreshCredentialEvidence({
      run,
      baseline,
      evidence,
      vaultCredentials: vaultAfter.credentials ?? [],
    });
    const observed = await call("operate_observe", { session_id: sessionId });
    const rendered = observed.dom ?? observed.text ?? "";
    assert.match(
      rendered,
      new RegExp(service.authPattern),
      "Real-service account evidence missing",
    );
    assert.match(
      rendered,
      new RegExp(service.provisionPattern),
      "Provisioning postcondition missing",
    );
    const probeAndCleanup = await probeThenCleanupFreshCredential({
      run,
      qualified,
      callUseCredential: async ({ reference, http }) =>
        await call("use_credential", { reference, http }),
      revokeCredential:
        typeof driver.revokeCredential === "function"
          ? async (providerCredential) =>
              await driver.revokeCredential({
                call,
                sessionId,
                initial,
                run,
                service,
                providerCredential,
              })
          : undefined,
    });
    const end = Date.now();
    process.send({
      event: "evidence",
      pid: process.pid,
      mcpPid: transport.pid,
      sessionId,
      start,
      end,
      url: observed.url,
      authenticated: true,
      provisioned: true,
      driver: service.driver,
      initial_auth_state: providerBaseline.initial_auth_state,
      document_lineage: {
        initial: {
          browser_epoch: initial.broker?.browserEpoch ?? null,
          target_id: initial.broker?.targetId ?? null,
          url: initial.url ?? null,
        },
        provisioned: {
          document_id: observed.document_id ?? observed.document?.id ?? null,
          browser_epoch: observed.browser_epoch ?? initial.broker?.browserEpoch ?? null,
          target_id: observed.target_id ?? initial.broker?.targetId ?? null,
          url: observed.url,
        },
      },
      calls,
      old_credential_control: {
        provider_id: oldControl.provider_credential_id,
        vault_reference: oldControl.vault_reference,
        probe_id: oldControl.probe.id,
        probed_at: oldProbeCompletedAt,
        qualified_as_fresh: false,
      },
      fresh_credential: {
        mutation_identity: {
          run_id: run.run_id,
          provider_credential_id: qualified.provider.id,
        },
        provider_id: qualified.provider.id,
        vault_reference: qualified.vault.reference,
        label: run.run_label,
        created_at: qualified.provider.created_at,
        provider: run.provider,
        provider_account_id: qualified.provider.account_id,
        probe_id: probeAndCleanup.probe_id,
        probed_at: probeAndCleanup.probe_completed_at,
        cleanup: probeAndCleanup.cleanup,
      },
    });
    await new Promise((r) => process.once("message", r));
    const after = await call("operate_observe", { session_id: sessionId });
    assert.equal(
      new URL(after.url).hostname,
      new URL(observed.url).hostname,
      "Cross-tab adoption after sibling teardown",
    );
    assert.match(after.dom ?? after.text ?? "", new RegExp(service.authPattern));
    const finish = await call("operate_finish", { session_id: sessionId }, 5_000);
    validateClosureReceipt(finish, sessionId);
    process.send({ event: "closed", pid: process.pid, sessionId, receipt: finish, calls });
    sessionId = undefined;
  } finally {
    if (sessionId !== undefined && call !== undefined) {
      try {
        await call("operate_finish", { session_id: sessionId }, 5_000);
      } catch (error) {
        process.stderr.write(
          `[broker-live-acceptance] bounded cleanup failed for session ${sessionId}: ${
            error instanceof Error ? error.message : String(error)
          }\n`,
        );
      }
    }
    await client.close();
    process.disconnect();
  }
}

async function ownedProcesses(profile) {
  return (await processInventory(profile)).owned;
}

export async function runLiveAcceptance(configPath) {
  return await runNativeAndConcurrencyAcceptance(configPath);
}

export function validateAcceptanceManifest(config) {
  assert.equal(config.schema_version, 1, "Live qualification requires schema_version: 1");
  assert.equal(typeof config.release?.artifact, "string", "Release artifact identity missing");
  assert.equal(typeof config.release?.version, "string", "Release version missing");
  assert.equal(typeof config.nativeLaunch?.command, "string", "Native launch command missing");
  assert.ok(Array.isArray(config.nativeLaunch?.args), "Native launch args missing");
  assert.equal(
    config.nativeLaunch?.expectedVersion,
    config.release.version,
    "Native expected version must equal the release under qualification",
  );
  assert.equal(
    config.credential_policy,
    FORCE_FRESH_CREDENTIAL_POLICY,
    "Live qualification requires credential_policy: force_fresh",
  );
  assert.ok(
    config.credential_cleanup_policy === "retain" || config.credential_cleanup_policy === "revoke",
    "Live qualification requires an explicit credential_cleanup_policy",
  );
  assert.equal(
    config.services?.length,
    3,
    "Exactly three overlapping client sessions are required",
  );
  assert.deepEqual(
    new Set(config.services.map((service) => service.provider)),
    new Set(["resend", "neon"]),
    "The three sessions must cover Resend and Neon without requiring another provider",
  );
  assert.equal(
    typeof config.configuredNativeEvidence,
    "string",
    "Configured native-host evidence path missing",
  );
  for (const service of config.services) {
    assert.equal(typeof service.provider, "string", "Each service requires a reviewed provider");
    reviewedCredentialProbe(service.provider);
    assert.equal(
      typeof service.providerAccountId,
      "string",
      "Each service requires its expected provider account identity",
    );
    assert.ok(
      service.oldCredentialControl && typeof service.oldCredentialControl === "object",
      "Each service requires an old valid credential negative control",
    );
    assert.equal(typeof service.driver, "string", "Each session requires a bounded driver module");
    assert.ok(
      (service.driverEvidence && typeof service.driverEvidence === "object") ||
        typeof service.driverEvidenceFile === "string",
      "Each session requires driverEvidence or driverEvidenceFile; see docs/browser-broker.md",
    );
  }
  acceptanceProfileGroups(config);
  return config;
}

export function acceptanceProfileGroups(config) {
  const groups = new Map();
  config.services.forEach((service, index) => {
    const profile = resolve(service.profileDir ?? config.profileDir);
    const group = groups.get(profile) ?? { profile, indices: [], sites: new Set() };
    const sites = [service.url, ...(service.allowedHosts ?? [])].map((host) => {
      const hostname = new URL(host.includes("://") ? host : `https://${host}`).hostname;
      return getDomain(hostname, { allowPrivateDomains: true }) ?? hostname;
    });
    for (const site of new Set(sites)) {
      assert.ok(
        !group.sites.has(site),
        "Overlapping sites require separately enrolled profileDir identities",
      );
      group.sites.add(site);
    }
    group.indices.push(index);
    groups.set(profile, group);
  });
  return [...groups.values()];
}

async function runConcurrencyAcceptance(configPath, config, nativeEvidence = null) {
  const root = process.cwd();
  const groups = acceptanceProfileGroups(config);
  const profile = resolve(config.profileDir);
  const configHome = resolve(config.configHome);
  assert.ok(
    profile.startsWith(root + "/"),
    "This task may use only an explicitly enrolled profile inside its worktree",
  );
  assert.ok(
    configHome.startsWith(root + "/"),
    "This task may use only an isolated config home inside its worktree",
  );
  for (const group of groups) {
    assert.ok(group.profile.startsWith(root + "/"), "Each enrolled profile must be worktree-local");
    await readFile(join(group.profile, "Local State"));
  }
  assert.equal(
    new Set(await Promise.all(groups.map((group) => realpath(group.profile)))).size,
    groups.length,
    "Profile aliases cannot share browser custody",
  );
  assert.ok(
    config.accountId && config.configHome,
    "Pinned account and isolated session-store path are required",
  );
  const qualification = await import("../dist/bot/broker/qualification.js");
  for (const group of groups)
    group.runId = await qualification.beginBrokerQualification(group.profile, config.accountId);
  let evidenceRecorded = false;
  const lab = resolve(root, ".broker-acceptance", `live-${Date.now()}`);
  await mkdir(lab, { recursive: true, mode: 0o700 });
  await mkdir(join(root, ".t"), { recursive: true, mode: 0o700 });
  const socket = join(root, ".t", `live-${process.pid}.sock`);
  const env = {
    ...process.env,
    HOME: configHome,
    XDG_CONFIG_HOME: configHome,
    TRUSTY_SQUIRE_ACCOUNT_ID: config.accountId,
    TRUSTY_SQUIRE_PROFILE_DIR: profile,
    TRUSTY_SQUIRE_BROKER_SOCKET: socket,
    TRUSTY_SQUIRE_EXPERIMENTAL_MULTISESSION: "0",
    TRUSTY_SQUIRE_REAPER_DIR: join(lab, "reapers"),
    TMPDIR: join(root, ".t"),
    BOT_CDP_ENDPOINT: "",
  };
  const inventory = async () =>
    (await Promise.all(groups.map((group) => ownedProcesses(group.profile)))).flat();
  const baseline = await inventory();
  assert.deepEqual(baseline, [], "Test identity is already in use");
  const children = [];
  const spawnChild = (args, ipc = true, extraEnv = {}) => {
    const child = spawn(process.execPath, args, {
      env: { ...env, ...extraEnv },
      stdio: ["ignore", "pipe", "pipe", ...(ipc ? ["ipc"] : [])],
    });
    children.push(child);
    child.stderr.on("data", (chunk) => process.stderr.write(chunk));
    child.done = new Promise((r, reject) => {
      child.once("error", reject);
      child.once("exit", (code) =>
        code === 0 ? r() : reject(new Error(`Child ${child.pid} exited ${code}`)),
      );
    });
    child.done.catch(() => {});
    return child;
  };
  const receive = (child, event) =>
    new Promise((r, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out: ${event}`)), 600000);
      const callback = (message) => {
        if (message.event === event) {
          clearTimeout(timer);
          child.off("message", callback);
          r(message);
        }
      };
      child.on("message", callback);
      child.done.catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
  const brokers = groups.map((group, index) => {
    group.env = {
      TRUSTY_SQUIRE_PROFILE_DIR: group.profile,
      TRUSTY_SQUIRE_BROKER_SOCKET: `${socket}.${index}`,
      TRUSTY_SQUIRE_BROKER_QUALIFICATION_RUN_ID: group.runId,
    };
    return spawnChild([bin, "broker"], false, group.env);
  });
  try {
    for (const [index, group] of groups.entries()) {
      for (let n = 0; n < 100; n++) {
        if (
          (await readdir(dirname(socket))).includes(
            group.env.TRUSTY_SQUIRE_BROKER_SOCKET.split("/").at(-1),
          )
        )
          break;
        if (brokers[index].exitCode !== null) await brokers[index].done;
        await delay(100);
      }
    }
    const clients = [0, 1, 2].map((index) =>
      spawnChild([script, "client", resolve(configPath), String(index)], true, {
        ...groups.find((group) => group.indices.includes(index)).env,
        TRUSTY_SQUIRE_FORWARDER_CREDENTIAL: randomBytes(32).toString("base64url"),
      }),
    );
    const ready = await Promise.all(clients.map((child) => receive(child, "ready")));
    assert.equal(new Set(ready.map((row) => row.mcpPid)).size, 3);
    assert.equal(new Set(ready.map((row) => row.sessionId)).size, 3);
    assert.equal(
      new Set(ready.map((row) => `${row.broker.browserEpoch}:${row.broker.targetId}`)).size,
      3,
    );
    assert.equal(new Set(ready.map((row) => row.broker.browserEpoch)).size, groups.length);
    const chromeRoots = [];
    for (const group of groups) {
      assert.equal(new Set(group.indices.map((index) => ready[index].broker.browserEpoch)).size, 1);
      const processes = await processInventory(group.profile);
      assert.equal(processes.chromeRoots.length, 1);
      chromeRoots.push(...processes.chromeRoots);
    }
    const pending = clients.map((child) => receive(child, "evidence"));
    clients.forEach((child) => child.send("go"));
    const rows = await Promise.all(pending);
    assert.ok(Math.max(...rows.map((r) => r.start)) < Math.min(...rows.map((r) => r.end)));
    const closedPending = clients.map((child) => receive(child, "closed"));
    clients[0].send("finish");
    await clients[0].done;
    clients.slice(1).forEach((child) => child.send("finish"));
    const closed = await Promise.all(closedPending);
    await Promise.all(clients.map((child) => child.done));
    await Promise.all(brokers.map((broker) => broker.done));
    for (let n = 0; n < 200 && (await inventory()).length !== 0; n++) await delay(100);
    const after = await inventory();
    assert.deepEqual(after, baseline);
    const evidence = {
      kind: "configured-native-and-real-service-three-session-acceptance",
      release: config.release,
      native: nativeEvidence,
      chromeRoots,
      ready,
      rows,
      closed,
      baseline,
      after,
    };
    const evidencePath = join(lab, "evidence.json");
    await writeFile(evidencePath, JSON.stringify(evidence, null, 2));
    for (const group of groups)
      await qualification.recordBrokerQualificationEvidence(
        group.profile,
        config.accountId,
        group.runId,
        evidencePath,
        config.services.map((service) => new URL(service.url).hostname),
      );
    evidenceRecorded = true;
    return { evidencePath, ...evidence };
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill("SIGTERM");
    await Promise.allSettled(children.map((child) => child.done));
    if (!evidenceRecorded)
      await Promise.all(
        groups.map((group) =>
          qualification.abandonBrokerQualification(group.profile, config.accountId, group.runId),
        ),
      );
  }
}

export async function runNativeAndConcurrencyAcceptance(configPath) {
  const config = validateAcceptanceManifest(JSON.parse(await readFile(configPath, "utf8")));
  const root = process.cwd();
  const profile = resolve(config.profileDir);
  const configHome = resolve(config.configHome);
  assert.ok(profile.startsWith(root + "/"), "Native diagnostic profile must be worktree-local");
  assert.ok(configHome.startsWith(root + "/"), "Native diagnostic config must be worktree-local");
  await mkdir(join(root, ".t"), { recursive: true, mode: 0o700 });
  const installedCommandResult = await runNativeLaunchDiagnostic({
    command: config.nativeLaunch.command,
    args: config.nativeLaunch.args,
    expectedVersion: config.nativeLaunch.expectedVersion,
    timeoutMs: config.nativeLaunch.timeoutMs ?? 35_000,
    env: {
      ...process.env,
      HOME: configHome,
      XDG_CONFIG_HOME: configHome,
      TRUSTY_SQUIRE_ACCOUNT_ID: config.accountId,
      TRUSTY_SQUIRE_PROFILE_DIR: profile,
      TRUSTY_SQUIRE_BROKER_SOCKET: join(root, ".t", `native-${process.pid}.sock`),
      BOT_CDP_ENDPOINT: "",
      TMPDIR: join(root, ".t"),
    },
  });
  const nativeLab = resolve(root, ".broker-acceptance", `native-${Date.now()}`);
  await mkdir(nativeLab, { recursive: true, mode: 0o700 });
  const nativeEvidencePath = join(nativeLab, "evidence.json");
  await writeFile(nativeEvidencePath, JSON.stringify(installedCommandResult, null, 2));
  const installedCommand = { ...installedCommandResult, evidence_path: nativeEvidencePath };
  assert.equal(
    installedCommand.outcome,
    "ready",
    `Installed-command MCP initialization failed; evidence=${nativeEvidencePath}: ${JSON.stringify(installedCommand)}`,
  );
  const configuredNativePath = resolve(dirname(configPath), config.configuredNativeEvidence);
  const configuredNative = validateConfiguredNativeConnectionEvidence(
    JSON.parse(await readFile(configuredNativePath, "utf8")),
    config.release.version,
  );
  return await runConcurrencyAcceptance(configPath, config, {
    installed_command: installedCommand,
    configured_host_connection: { ...configuredNative, evidence_path: configuredNativePath },
  });
}
if (process.argv[2] === "client") await runClient(process.argv[3], Number(process.argv[4]));
