# Corresponding Source and Build Information

For each release, the complete project source is the repository tree at the matching `v<version>` tag. GitHub's automatically generated source archives and the explicit `chatgpt-account-keeper-<version>-source.zip` release asset contain that tree, including build scripts and workflow definitions.

Windows build requirements and commands are documented in `README.md`. Exact JavaScript dependency versions are recorded in `package-lock.json`; .NET dependencies are recorded in project metadata and the generated release SBOM; private runtime versions and hashes are recorded in `build/runtime-versions.json`.

The Windows package includes an unmodified mihomo executable under GPL-3.0. Its corresponding source is published as `mihomo-v1.19.29-source.zip` beside the release and is also available from https://github.com/MetaCubeX/mihomo/tree/v1.19.29. The installed package includes the exact GPL license and runtime-version record under `licenses/`.

Node.js source for the bundled v24.11.1 runtime is available from https://github.com/nodejs/node/tree/v24.11.1 and https://nodejs.org/dist/v24.11.1/. Other dependency source locations and licenses are indexed in `THIRD_PARTY_NOTICES.md` and the release SBOM.

## Release signing status

Windows release artifacts are **not** Authenticode signed. Windows SmartScreen may warn on first download or run of the installer and the main executable; this is expected for unsigned software. Verify a download against `SHA256SUMS.release.txt`, published beside the binary assets of each release.
