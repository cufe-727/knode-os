# Local macOS installation

For local desktop installation and update tasks, including debug installs,
reuse the existing installation. Follow this workflow unless the user explicitly
requests a separate installation:

- Run `./macos/scripts/install-app.sh` from the repository root. It builds and
  performs every step below; pass `--no-build` to install an existing build and
  `--backup` to keep the replaced bundle as the single rollback archive.
- Build with `./macos/scripts/package-app.sh` from the repository root. Install
  `macos/build/KnodeOS.app` at the fixed path `/Applications/KnodeOS.app` and
  preserve its bundle identifier, `dev.knode.os`. Always launch that installed path.
- Do not create dated, versioned, `backup`, `previous-install`, or `previous-build`
  application copies in Applications, the repository, or Application Support. If a
  persistent rollback copy is needed, keep just one compressed archive at
  `~/Library/Application Support/KnodeOS/install-backups/previous.zip`.
- Prepare and validate the complete new bundle in a hidden temporary directory
  beside the target. Gracefully stop the app and its bundled service before
  replacement. Swap the entire bundle instead of merging files into the old app.
  Keep the old bundle inside that hidden temporary directory until the installed
  app starts successfully; restore it if replacement or startup fails. A
  successful `open` command alone does not establish application health.
- After successful installation, clean up the temporary directory and the
  verified, reproducible `.app` build output. If the build bundle must be retained,
  archive it instead of leaving another loose `.app` for macOS to index. Preserve
  source files, other build artifacts, application settings, and databases.
- Unregister the build and temporary bundle paths with `lsregister -u`, then
  refresh only `/Applications/KnodeOS.app` with `lsregister -f`. Do not reset
  LaunchServices or Spotlight globally. Verify the installed app is running from
  the fixed path and that no extra KnodeOS application entry was introduced.
