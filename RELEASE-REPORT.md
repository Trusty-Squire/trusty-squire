# Trusty Squire MCP 1.1.14-rc.13 release report

Date: 2026-09-10 America/New_York / 2026-09-11 UTC

## Source and merge

- Release PR: https://github.com/Trusty-Squire/trusty-squire/pull/721
- Reviewed release head: `dff420ba4415e36dca0132b5a9160606ba257593`
- Merge SHA: `f738871b7e5830e40134e3dffdb6d373f44bde7b`
- Git tag `v1.1.14-rc.13` resolves to the merge SHA.
- The reviewed release-head tree and merged release-source tree have no diff.
- Merged source contains PRs #717, #718, #719, and #720. Protected patch
  `22683018645719510596621e1db2a07e8a987926` remains in `main` ancestry.

## Checks and publication

- PR CI run `34550254517`, exact head `dff420ba`: 5 passed, 0 failed
  (`secret-scan`, `typecheck`, `build`, `mcp-node26-native-prebuild`, `test`).
- Release workflow run `34551226585`, exact merge SHA `f738871b`: conclusion
  `success`; both `verify` and `publish` jobs concluded `success`.
- GitHub release `v1.1.14-rc.13` exists and names all four included fix PRs.
- `scripts/verify-install.sh @trusty-squire/mcp 1.1.14-rc.13 'case "connect"'`
  passed version lookup, `next` tag, full-registry-document cross-check,
  tarball HTTP 200, sentinel inspection, and clean temporary install.
- Both `npm view` and `https://registry.npmjs.org/@trusty-squire/mcp` report
  `next: 1.1.14-rc.13` and `latest: 1.1.13`.

## Artifact and clean-install evidence

- A package built and packed from a clean `git archive` of merge SHA `f738871b`
  has SHA-256
  `3d8b3ad4010a67430fd0040cca885ad32b5619bb8c83bf34c0a6f0eb68994c3e`.
- The official-registry tarball has the same SHA-256. Extracted manifests match
  across all 404 payload files.
- A separate clean `npm install @trusty-squire/mcp@next` resolved package and
  executable version `1.1.14-rc.13`.
- With isolated temporary `HOME` and XDG directories, the installed `mcp server`
  initialize handshake returned protocol `2024-11-05`, server name
  `trusty-squire`, and server version `1.1.14-rc.13`. Closing stdin produced
  exit code 0 with no signal.

## Limitations and handoff

- Manual OAuth/display smoke remains pending by captain instruction; it did not
  gate this RC because no suitable local display was available.
- Captain owns Hermes testing. Firstmate owns native live testing and personal
  Exa, Groq, and Cartesia retries, including its own connection configuration.
- No live operator, login, browser profile, cookie, account configuration, or
  purchase flow was used during this release verification.
