# Polls the physical keyboard so the overlay hotkey works even when a game or another
# program swallows Shift+F2 / has the global shortcut. Prints "toggle" on each F2 press with Shift or Alt held.
# UNVERIFIED: not run against a real game; cannot see keys typed into an elevated (admin) window.
Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;
public static class DubKeys { [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vk); }
'@
$was = $false
while ($true) {
  if (-not (Get-Process -Id ([int]$env:DUB_APP_PID) -ErrorAction SilentlyContinue)) { break }
  $down = ([DubKeys]::GetAsyncKeyState(0x71) -band 0x8000) -ne 0
  if ($down -and -not $was) {
    $mod = ([DubKeys]::GetAsyncKeyState(0x10) -band 0x8000) -ne 0 -or ([DubKeys]::GetAsyncKeyState(0x12) -band 0x8000) -ne 0
    if ($mod) { 'toggle' }
  }
  $was = $down
  Start-Sleep -Milliseconds 25
}
