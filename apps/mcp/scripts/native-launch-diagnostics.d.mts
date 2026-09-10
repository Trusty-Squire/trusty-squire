export interface InstalledMcpLaunchConfig {
  command: string;
  args: string[];
}

export interface NativeLaunchSpec extends InstalledMcpLaunchConfig {
  expectedVersion: string;
}

export function nativeLaunchSpecFromInstalledConfig(
  config: InstalledMcpLaunchConfig,
  expectedVersion: string,
): NativeLaunchSpec;
