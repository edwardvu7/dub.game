# One worker per launched game. Paths arrive as environment data, never interpolated code.
# UNVERIFIED: native Win32 behavior must be rehearsed on Windows with the target game.
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class DubWindow {
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct Point { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] public struct Monitor { public int Size; public Rect Bounds, Work; public uint Flags; }
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out Rect r);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref Point p);
  [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr h, uint flags);
  [DllImport("user32.dll")] public static extern bool GetMonitorInfo(IntPtr h, ref Monitor m);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int index);
  [DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr h, int index, int value);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int height, uint flags);
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  public static bool Borderless(IntPtr h) {
    var m = new Monitor(); m.Size = Marshal.SizeOf(typeof(Monitor));
    if (!GetMonitorInfo(MonitorFromWindow(h, 2), ref m)) return false;
    // Strip caption and resize frame; keep the game's other styles and z-order.
    SetWindowLong(h, -16, GetWindowLong(h, -16) & ~0x00C40000);
    return SetWindowPos(h, IntPtr.Zero, m.Bounds.Left, m.Bounds.Top,
      m.Bounds.Right-m.Bounds.Left, m.Bounds.Bottom-m.Bounds.Top, 0x0034);
  }
}
'@
[void][DubWindow]::SetThreadDpiAwarenessContext([IntPtr](-4))
$root = [IO.Path]::GetFullPath($env:DUB_TRACK_DIR).TrimEnd('\') + '\'
$targetPid = [int]$env:DUB_TRACK_PID
$handle = [IntPtr]::Zero
$owner = 0
$deadline = [DateTime]::UtcNow.AddMinutes(2)
$borderlessAt = $null
while ($true) {
  if (-not (Get-Process -Id ([int]$env:DUB_APP_PID) -ErrorAction SilentlyContinue)) { break }
  $fg = [DubWindow]::GetForegroundWindow()
  if ($handle -eq [IntPtr]::Zero) {
    if ([DateTime]::UtcNow -gt $deadline) { break }
    [uint32]$candidate = 0
    [void][DubWindow]::GetWindowThreadProcessId($fg, [ref]$candidate)
    $matches = $false
    try {
      if ($targetPid -gt 0) { $matches = $candidate -eq $targetPid }
      else {
        $exe = (Get-Process -Id $candidate -ErrorAction Stop).Path
        $matches = $exe -and $exe.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)
      }
    } catch {}
    if ($matches -and [DubWindow]::IsWindowVisible($fg)) {
      $handle = $fg; $owner = $candidate
      $borderlessAt = [DateTime]::UtcNow.AddSeconds(1)
    }
  }
  if ($handle -ne [IntPtr]::Zero) {
    [uint32]$currentOwner = 0
    [void][DubWindow]::GetWindowThreadProcessId($handle, [ref]$currentOwner)
    if (-not [DubWindow]::IsWindow($handle) -or $currentOwner -ne $owner) { break }
    if ($borderlessAt -and [DateTime]::UtcNow -ge $borderlessAt -and $fg -eq $handle) {
      if (-not [DubWindow]::Borderless($handle)) {
        @{ error = 'Windows could not position the game. Use its borderless display setting.' } | ConvertTo-Json -Compress
      }
      $borderlessAt = $null
    }
    $r = New-Object DubWindow+Rect
    $p = New-Object DubWindow+Point
    $valid = [DubWindow]::GetClientRect($handle, [ref]$r) -and [DubWindow]::ClientToScreen($handle, [ref]$p)
    if ($valid) {
      @{ x=$p.X; y=$p.Y; width=($r.Right-$r.Left); height=($r.Bottom-$r.Top);
         focused=($fg -eq $handle); minimized=([DubWindow]::IsIconic($handle) -or -not [DubWindow]::IsWindowVisible($handle)) } | ConvertTo-Json -Compress
    }
  }
  Start-Sleep -Milliseconds 150
}
