# Kimi Code Community (Unofficial)

An unofficial, community-maintained build of the Kimi Code extension for VS
Code. It is based on the open-source extension from Moonshot AI, but it is not
affiliated with or endorsed by Moonshot AI.

This build currently packages Windows x64 only and contains downstream fixes
and features:

- Keep long-running chat streams alive instead of applying the bridge's generic
  ten-minute request timeout (the change proposed in upstream PR
  [#3032](https://github.com/MoonshotAI/kimi-code/pull/3032)).
- Preserve completed, cancelled, blocked, and interrupted `/compact` outcomes;
  stopped cards no longer appear successful or start animating again.
- Reduce resize stalls during streaming by coalescing text deltas and deferring
  rich Markdown parsing until a text or thinking block has finished.
- Navigate long conversations through a compact prompt/response outline,
  timestamped entries, previous/next controls, and scroll-aware shortcut
  markers on the left edge; open it from the composer action row.
- Undo from any available user prompt with the arrow below its bubble; the
  selected prompt is restored to the composer, with an optional conflict-safe
  rollback for file changes made through Kimi Write/Edit tools.

## Features

- **Works alongside you**: Kimi autonomously explores your codebase, reads and writes code, and runs terminal commands with your permission
- **Thinking controls**: Toggle reasoning or choose a model-supported thinking effort
- **Provider-aware models**: Distinguish and select same-named models across configured providers
- **Native editor integration**: Review AI-proposed changes directly in VS Code's diff viewer
- **MCP support**: Extend capabilities with Model Context Protocol servers
- **Slash commands**: Quick actions like `/init` to analyze your project and `/compact` to manage context
- **Conversation undo**: Return the model context to an earlier prompt and optionally restore tracked file changes

## Install

Kimi Code requires VS Code 1.100.0 or later.

1. Disable or uninstall the official `moonshot-ai.kimi-code` extension. The two
   builds use the same command, view, configuration, and session identifiers,
   so running them together is unsupported.
2. Download `kimi-code-community-win32-x64.vsix` and `SHA256SUMS.txt` from the
   matching [GitHub release](https://github.com/LCZcn96/kimi-code/releases).
3. Compare the VSIX SHA-256 digest with `SHA256SUMS.txt`, then install it:

   ```powershell
   (Get-FileHash -Algorithm SHA256 .\kimi-code-community-win32-x64.vsix).Hash.ToLowerInvariant()
   code --install-extension .\kimi-code-community-win32-x64.vsix --force
   ```

4. Open a folder in VS Code, click **Kimi Code Community** in the Activity Bar,
   and sign in or use an existing provider configuration.

VSIX installations do not receive this fork's releases automatically. Repeat
the download, checksum, and install steps to update. The extension ID is
`lczcn96.kimi-code`; release assets are the supported distribution channel,
not the VS Code Marketplace.

The extension runs the Kimi Code Node SDK in the VS Code Extension Host. When
the extension and the Kimi Code terminal app resolve to the same
`KIMI_CODE_HOME`, they share `config.toml`, MCP configuration, login state, and
sessions. The system-level `KIMI_CODE_HOME` environment variable is supported;
there is no separate VS Code setting for it. Do not run the same session from
both applications at the same time, because cross-process session locking is
not guaranteed.

After upgrading from version 0.5.x, the extension prompts before migrating any
legacy data it finds. Migration copies or merges data into the current Kimi Code
home and does not delete the legacy source. Legacy Kimi Code OAuth and MCP OAuth
credentials are not copied, so those connections must be authorized again.
See [the changelog](CHANGELOG.md) for the full compatibility notes.

## Upstream docs

The upstream Kimi Code documentation is available at
[www.kimi.com/code/docs](https://www.kimi.com/code/docs/en/kimi-code-for-vscode/guides/getting-started.html).
Fork-specific maintenance and release details are in
[COMMUNITY.md](https://github.com/LCZcn96/kimi-code/blob/community/COMMUNITY.md).

## License

[Apache-2.0](LICENSE)
