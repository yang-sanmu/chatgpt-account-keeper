# Corresponding Source and Build Information

For each release, the complete project source is the repository tree at the matching `v<version>` tag. GitHub's automatically generated source archives and the explicit `chatgpt-account-keeper-<version>-source.zip` release asset contain that tree, including build scripts and workflow definitions.

Windows build requirements and commands are documented in `README.md`. Exact JavaScript dependency versions are recorded in `package-lock.json` (Agent) and `app/package-lock.json` (Tauri client frontend), and every platform release includes an Agent SBOM. The chrome-launcher broker has no external `PackageReference`; its .NET SDK is pinned by `desktop/global.json`. Rust dependencies are recorded in `app/src-tauri/Cargo.lock`; private runtime versions and hashes are recorded in `build/runtime-versions.json`.

The management client is mid-migration from Avalonia (`desktop/`) to Rust + Tauri (`app/`); see `docs/TAURI_MIGRATION_PLAN.md`. Both trees are in the repository, and each release states which client it ships. The Tauri client embeds its frontend assets in the executable and loads them over a custom protocol rather than an HTTP server, so it does not offer program functionality over a network within the meaning of AGPL section 13.

The release packages include an unmodified, platform-specific mihomo executable under GPL-3.0. Its corresponding source is published as `mihomo-v1.19.29-source.zip` beside the release and is also available from https://github.com/MetaCubeX/mihomo/tree/v1.19.29. The installed package includes the exact GPL license and runtime-version record under `licenses/`.

Node.js source for the bundled v24.11.1 runtime is available from https://github.com/nodejs/node/tree/v24.11.1 and https://nodejs.org/dist/v24.11.1/. Other dependency source locations and licenses are indexed in `THIRD_PARTY_NOTICES.md` and the release SBOM.

## Release signing status

Formal Tauri releases use four independent integrity layers: Tauri updater signatures on NSIS,
macOS app archives and AppImage; Authenticode with a trusted timestamp on Windows; Developer ID
signing, notarization and stapling on macOS; and detached Minisign signatures for the Linux
AppImage and checksum manifest. `SHA256SUMS.release.txt` covers every public release asset.

The local Windows inspection script intentionally omits Authenticode and marks its output
`UNSIGNED-win-x64.txt`; that output cannot pass the cross-platform Draft gate and must not be
published as a formal release.
