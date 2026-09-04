# Kimi Code Community

Kimi Code Community is an unofficial, community-maintained build of the VS Code
extension in this repository. It is not affiliated with or endorsed by
Moonshot AI. The upstream project remains
[`MoonshotAI/kimi-code`](https://github.com/MoonshotAI/kimi-code).

## Scope

The community release changes and distributes only `apps/vscode`. It does not
publish replacement CLI, SDK, npm, Marketplace, or Open VSX packages. Version
0.7.5 is based on upstream VS Code extension 0.7.5 at commit `523d35b54` and
contains:

- the long-running stream timeout fix proposed in upstream PR
  [#3032](https://github.com/MoonshotAI/kimi-code/pull/3032);
- correct terminal and visual state for completed, cancelled, blocked, and
  interrupted compaction cards;
- lower streaming resize cost through event coalescing and a lightweight
  unfinished-Markdown path; and
- prompt navigation with a compact outline, previous/next actions, active-item
  tracking, timestamped entries, a centered panel, and clickable shortcut
  markers along the left edge of the chat, opened from the composer action
  row; and
- conversation undo from user prompt bubbles, including prompt/media restore,
  compaction and cleared-context boundaries, plus an opt-in, conflict-safe
  rollback for changes made through Kimi Write/Edit tools. File rollback is
  disabled by default.

The packaged extension ID is `lczcn96.kimi-code`. It deliberately keeps the
upstream internal `kimi.*` identifiers so that sessions, settings, and behavior
remain compatible. Consequently, it must not run beside the official
`moonshot-ai.kimi-code` extension. Disable or uninstall the official extension
before installing the community VSIX.

## Releases

Windows x64 is the initial supported target. Each `community-vX.Y.Z` Git tag
uses the same `X.Y.Z` as the corresponding official VS Code extension and is
built on GitHub Actions from source. Its GitHub Release contains the VSIX and a
UTF-8, no-BOM `SHA256SUMS.txt` file. Install and update manually:

```powershell
(Get-FileHash -Algorithm SHA256 .\kimi-code-community-win32-x64.vsix).Hash.ToLowerInvariant()
code --install-extension .\kimi-code-community-win32-x64.vsix --force
```

The value printed by `Get-FileHash` must match `SHA256SUMS.txt`. Manual VSIX
installs do not automatically follow this fork's GitHub Releases.

## Maintenance model

The long-lived `community` branch contains downstream commits. `origin` denotes
the official repository and `fork` denotes `LCZcn96/kimi-code`. Published
history is not rebased; upstream is merged so release tags remain verifiable.

```powershell
git fetch origin --prune
git switch community
git merge --no-ff origin/main
pnpm install --frozen-lockfile
pnpm --dir apps/vscode exec vitest run --config vitest.config.ts `
  test/bridge-handler.test.ts test/session-runtime.test.ts `
  test/settings-store.test.ts test/event-adapter.test.ts `
  test/replay-adapter.test.ts test/vsix-package.test.ts
pnpm --dir apps/vscode typecheck
```

After resolving a duplicate or conflicting upstream fix, retain the upstream
implementation when it satisfies the downstream regression tests. Keep
fork-only changes as small commits grouped by concern. Before a release:

1. Update `apps/vscode/package.json` and this document to the current upstream
   VS Code extension version.
2. Run the focused VS Code tests, typecheck, VSIX packaging, package audit, and
   extension-host smoke test on the target platform.
3. Push `community`, then create and push `community-vX.Y.Z`. The tag must match
   the extension version or the release workflow fails.
4. Download the published assets and independently verify their checksum and
   extension identity.

Report downstream packaging and behavior bugs in
[`LCZcn96/kimi-code`](https://github.com/LCZcn96/kimi-code/issues). Reproduce
issues against the official build before forwarding an upstream regression.

## License and attribution

The repository retains its upstream licenses and copyright notices. The VS Code
extension is distributed under the Apache-2.0 license in
`apps/vscode/LICENSE`; other repository components may use different licenses.
"Kimi" and "Moonshot AI" are used only to identify the upstream project and
compatibility. No trademark affiliation or endorsement is claimed.
