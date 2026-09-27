/** A Beeline room gives every agent a stable private HOME across MCP process
 * restarts. Other callers without an explicit identity stay process-scoped. */
export function brokerAgentIdentity(
  env: NodeJS.ProcessEnv = process.env,
  pid = process.pid,
): string {
  const configured = env.TRUSTY_SQUIRE_AGENT_IDENTITY?.trim();
  if (configured) return configured;
  const room = env.HOME?.match(
    /(?:^|\/)\.local\/state\/beeline\/agents\/([a-f0-9]+)\/rooms\/([a-f0-9-]+)\/agent-home\/user\/?$/,
  );
  if (room) return `beeline:${room[1]}:${room[2]}`;
  return `local-process:${pid}`;
}
