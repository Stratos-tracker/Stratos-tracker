# Updates

How Stratos tells a user a newer version exists, and what publishing one involves.

## The thing the app reads

Every release writes two generated files:

| File | What it is | Who reads it |
| --- | --- | --- |
| `app/version.json` | The latest release: version, minimum supported version, download table, notes, date | The startup check in every surface |
| `app/releases.json` | The full history behind the update centre's list | Settings → Updates, the download page |

Both are produced by `scripts/release-notes.mjs` from the release that is being
cut, then copied to `main` by the publish job. The site serves them from its own
origin, so no client needs a GitHub token, an account, or a release asset.

`version.json` is a snapshot of the latest release:

```json
{
  "schemaVersion": 1,
  "latestVersion": "2.1.35",
  "minimumSupportedVersion": "",
  "mandatory": false,
  "releaseDate": "2026-11-06",
  "downloadUrl": "https://github.com/.../v2.1.35/Stratos-Setup.exe",
  "downloads": {
    "windows":   { "url": "…/Stratos-Setup.exe", "sha256": "…", "size": 109000000 },
    "mac-arm64": { "url": "…/Stratos-2.1.35-mac-arm64.dmg", "sha256": "…", "size": 125000000 },
    "mac-x64":   { "url": "…/Stratos-2.1.35-mac-x64.dmg", "sha256": "…", "size": 130000000 },
    "linux-x64": { "url": "…/Stratos-2.1.35-linux-x64.AppImage", "sha256": "…", "size": 146000000 }
  },
  "releaseNotes": ["One line per change"],
  "notes": { "features": [], "improvements": [], "fixes": [] },
  "summary": "One sentence about the release."
}
```

`minimumSupportedVersion` is the oldest build that may keep running without
updating. Leave it empty for an ordinary release. `mandatory: true` (or a
`critical` release with a reason) removes **Remind me later**, so the prompt
cannot be dismissed — but it never blocks the app: if the manifest cannot be
reached, Stratos carries on and checks again later.

## What the app does

- Checks 2.5 s after start, then every six hours, then when the window becomes
  visible again (at most hourly) — never on every page navigation.
- Compares versions semantically. Same version, older manifest, or a failed
  request: no prompt.
- Remembers a dismissal per release fingerprint, so **Remind me later** is
  honoured until the release itself changes or a newer one is published.
- Keeps the last good answer, so an offline launch still knows what it knew and
  a failed check never invents a version.
- Shows one dialog at a time, from the same component on desktop and mobile.

**Update Now** opens the published installer for the running platform (Windows
installer, macOS DMG, Linux AppImage). In the desktop app the URL is opened by
the main process, which only accepts `github.com` and `stratos-tracker.com`
addresses. Nothing installs silently: the user runs the installer, and the
logbook, routes, aircraft profiles, settings and SimBrief configuration are
never touched.

Downloads are chosen by platform: `windows`, `mac-arm64`, `mac-x64`,
`linux-x64`, falling back to the manifest's `downloadUrl`.

## Publishing a release

1. Bump the version in one place:
   ```bash
   npm version --no-git-tag-version 2.1.36
   python3 scripts/stamp-version.py 2.1.36
   ```
2. Write the notes in `release-notes/curated.json` under the new version
   (`summary` plus `changelog.features|improvements|fixes`).
3. Generate both manifests from the commits and the curated notes:
   ```bash
   node scripts/release-notes.mjs --version 2.1.36 --from v2.1.35
   node scripts/release-notes.mjs --check
   ```
4. Commit, tag and push `main` and the tag. The Release workflow builds the
   installers, writes the download table into `releases.json`/`version.json`,
   publishes the release, and copies both manifests back to `main`.

That is the whole process. The version number, the notes and the download URLs
come from the build itself, so there is no second file to hand-edit.

### Making an update mandatory

- **One release:** cut it with `--severity critical --reason "…"`. The dialog
  explains the reason and drops **Remind me later**.
- **An old build:** set `minimumSupportedVersion` in the release (the publish job
  accepts `--minimum 2.1.20`); every client older than that is told why an update
  is required.

### Verifying a release published correctly

```bash
node scripts/check-version-manifest.mjs        # main's published manifests
node scripts/check-version-manifest.mjs --tag v2.1.36
node scripts/check-release.mjs 2.1.36          # installers and their digests
```

The **Update manifest smoke test** workflow runs the first of these after every
Release run, and fails if the release page carries anything other than one
installer per platform.

## What deliberately does not happen

- No updater feeds (`latest.yml`) and no update ZIPs are published. The app does
  not replace its own files; an update is an installer the user runs.
- No silent install, no app restart while a flight is being tracked.
- No prompt for a version the user already has, and no second prompt for one
  they postponed.
- No update check on the login or account path: updates never require signing in.
