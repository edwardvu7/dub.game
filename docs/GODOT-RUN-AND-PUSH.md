# Run this update and push it to GitHub (Windows PowerShell)

The ZIP includes the entire project plus a Git bundle containing the committed
branch and its history. You do not need to copy changed files over your clone.
This is source code, not a precompiled Windows installer. Node.js 20+ and internet
access are required for the initial npm install. Your game and API keys are not included.

## Run the extracted project first

1. Extract `dub-game-generic-godot.zip` to Downloads. Open the extracted folder.
   It contains `dub-game`, `dub-game-update.bundle`, and `START-HERE.md`.
2. Open the inner `dub-game` folder. Double-click `start.bat`.
   Alternatively, in PowerShell:

```powershell
$update = Join-Path $env:USERPROFILE 'Downloads\dub-game-generic-godot'
Set-Location "$update\dub-game"
npm.cmd ci
npm.cmd start
```

If the extracted folder has a different name, change only the `$update` path.
Do not launch two copies of dubplay at once: both use port 8000.

3. Close the game. Enable **Voices** on its Godot tile, then launch it.
4. Enable **Narration** in Settings. Open the cutscene and check the connection.
5. If connected but no dialogue is found, expand **Choose dialogue text** and
   select the node showing that sentence. Save. The running hook refreshes it.
6. Test advancing and skipping dialogue, stopping voices, and your overlay.

Until Then is not verified. See `docs/GODOT-GENERIC.md` for what the tests cover and
how to distinguish a loading failure from missed text selection.

## Import the committed update into your existing Desktop clone

Close dubplay first. Use the SAME PowerShell window for the commands below.
Run each block separately. If any Git command fails, stop before the next block.
Do not delete your Desktop clone.

1. Select your existing clone and check that it is clean:

```powershell
$update = Join-Path $env:USERPROFILE 'Downloads\dub-game-generic-godot'
$repo = Join-Path ([Environment]::GetFolderPath('Desktop')) 'dub-game'
Set-Location $repo
git status
```

It should say `nothing to commit, working tree clean`. If you have your own edits,
commit or stash them first. This bundle includes the delivered implementation;
edits you made while testing the separate extracted copy are not included in it.
Make future changes in the Desktop clone after importing.

2. Set commit identity for this clone (already authorized by you):

```powershell
git config user.name "Matthew Harber"
git config user.email "135185118+Craz33matt@users.noreply.github.com"
```

3. Import the update branch:

```powershell
git fetch "$update\dub-game-update.bundle" feature/generic-godot-hook
git switch -c feature/generic-godot-hook FETCH_HEAD
```

If the branch already exists, stop and inspect `git branch -v`; do not delete it or
force-reset it. The commands above are for the first import of this bundle.

4. Merge any new work your friends pushed since this update was prepared:

```powershell
git fetch origin
git merge --no-edit origin/main
```

If there are merge conflicts, stop and resolve them before testing or pushing.
If the merge succeeds, all changes are on the feature branch, not main yet.

5. Install and test the combined project:

```powershell
npm.cmd ci
npm.cmd test
npm.cmd run smoke
npm.cmd start
```

Close the app to return to the PowerShell prompt. Recheck your game after merging.
The Godot smoke checks are optional and require a Godot executable; instructions
are in `docs/GODOT-GENERIC.md`.

6. Push the branch:

```powershell
git push -u origin feature/generic-godot-hook
```

Open:
https://github.com/edwardvu7/dub.game/compare/main...feature/generic-godot-hook

Create a pull request with base `main`. Review the changed files and tests, then
merge it when ready. Your friends can pull main after the PR is merged:

```powershell
git switch main
git pull --ff-only origin main
npm.cmd ci
```

Do not use force-push. Pushing the feature branch alone does not update main.
If GitHub denies permission, the repository owner must give your account write
access, or you can push to your own fork and open a PR.

## Build your own Windows installer

From the project folder on Windows:

```powershell
npm.cmd ci
npm.cmd run dist
```

The installer is written to `dist`. This command builds locally; it does not
publish a GitHub release. For a new version, update package.json's version and
regenerate package-lock.json with `npm.cmd install --package-lock-only`, then
commit those changes. Never commit `node_modules`, API keys, or `dist`.
