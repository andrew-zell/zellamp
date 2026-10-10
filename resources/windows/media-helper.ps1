# Zellamp's Windows media helper.
#
# Bridges Windows' system media controls (the session Spotify, browsers and
# other players publish to the volume-flyout media widget) to Zellamp over
# stdin/stdout, one JSON object per line.
#
#   in:  {"id":1,"cmd":"playpause"}   cmds: play pause playpause next prev
#        {"id":2,"cmd":"seek","value":42.5}       shuffle/repeat value: bool
#        {"id":3,"cmd":"volume","value":65}       volume value: 0-100
#   out: {"type":"state",...}   whenever something changes
#        {"type":"ack","id":1,"ok":true}
#        {"type":"error","message":"..."}
#
# Requires Windows 10 1809+ and Windows PowerShell 5.1 (built in). Run with
# -MTA: on PowerShell's default STA thread nothing pumps messages, so the
# media session objects never receive their updates and report stale state.

$ErrorActionPreference = 'Stop'

# Raw stdout stream, not [Console]::Out: in .NET Framework a thread blocked in
# Console.ReadLine (our command reader below) also blocks Console writes, so
# state would only go out after Zellamp sent a command.
$stdout = New-Object System.IO.StreamWriter([Console]::OpenStandardOutput(), (New-Object System.Text.UTF8Encoding $false))
$stdout.AutoFlush = $true

function Send-Line([string]$json) { $stdout.WriteLine($json) }
function Send($obj) { Send-Line ($obj | ConvertTo-Json -Compress -Depth 4) }

try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
  $null = [Windows.Media.MediaPlaybackAutoRepeatMode, Windows.Media, ContentType = WindowsRuntime]
  $null = [Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType = WindowsRuntime]
} catch {
  Send @{ type = 'error'; message = "WinRT media APIs unavailable: $($_.Exception.Message)" }
  exit 2
}

# ---------- await WinRT async operations from PowerShell ----------

$asTaskMethod = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  })[0]

function Await($operation, [Type]$resultType) {
  $task = $asTaskMethod.MakeGenericMethod($resultType).Invoke($null, @($operation))
  if (-not $task.Wait(4000)) { throw 'WinRT call timed out' }
  $task.Result
}

$SessionManager = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]
$MediaProperties = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties]
$manager = Await ($SessionManager::RequestAsync()) ($SessionManager)
Send @{ type = 'hello'; powershell = $PSVersionTable.PSVersion.ToString(); os = [Environment]::OSVersion.VersionString }

# ---------- per-app volume (Windows Core Audio, via a small C# shim) ----------

Add-Type -Language CSharp -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;

public static class ZellampAppVolume {
  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
  class MMDeviceEnumerator {}

  [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDeviceEnumerator {
    int NotImpl_EnumAudioEndpoints();
    [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
  }

  [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDevice {
    [PreserveSig] int Activate(ref Guid iid, int clsCtx, IntPtr activationParams,
      [MarshalAs(UnmanagedType.IUnknown)] out object instance);
  }

  [Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioSessionManager2 {
    int NotImpl_GetAudioSessionControl();
    int NotImpl_GetSimpleAudioVolume();
    [PreserveSig] int GetSessionEnumerator(out IAudioSessionEnumerator sessionEnum);
  }

  [Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioSessionEnumerator {
    [PreserveSig] int GetCount(out int count);
    [PreserveSig] int GetSession(int index, out IAudioSessionControl2 session);
  }

  // IAudioSessionControl (9 methods) then IAudioSessionControl2.
  [Guid("bfb7ff88-7239-4fc9-8fa2-07c950be9c6d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioSessionControl2 {
    int NotImpl0(); int NotImpl1(); int NotImpl2(); int NotImpl3(); int NotImpl4();
    int NotImpl5(); int NotImpl6(); int NotImpl7(); int NotImpl8();
    int NotImpl_GetSessionIdentifier(); int NotImpl_GetSessionInstanceIdentifier();
    [PreserveSig] int GetProcessId(out uint pid);
  }

  [Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface ISimpleAudioVolume {
    [PreserveSig] int SetMasterVolume(float level, ref Guid eventContext);
    [PreserveSig] int GetMasterVolume(out float level);
  }

  static ISimpleAudioVolume[] Find(string processName) {
    var found = new System.Collections.Generic.List<ISimpleAudioVolume>();
    var enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumerator());
    IMMDevice device;
    if (enumerator.GetDefaultAudioEndpoint(0 /* render */, 1 /* multimedia */, out device) != 0) return found.ToArray();
    Guid iid = typeof(IAudioSessionManager2).GUID;
    object o;
    if (device.Activate(ref iid, 23 /* CLSCTX_ALL */, IntPtr.Zero, out o) != 0) return found.ToArray();
    var manager = (IAudioSessionManager2)o;
    IAudioSessionEnumerator sessions;
    if (manager.GetSessionEnumerator(out sessions) != 0) return found.ToArray();
    int count;
    sessions.GetCount(out count);
    for (int i = 0; i < count; i++) {
      IAudioSessionControl2 control;
      if (sessions.GetSession(i, out control) != 0) continue;
      uint pid;
      if (control.GetProcessId(out pid) != 0 || pid == 0) continue;
      try {
        if (string.Equals(Process.GetProcessById((int)pid).ProcessName, processName, StringComparison.OrdinalIgnoreCase))
          found.Add((ISimpleAudioVolume)control);
      } catch {}
    }
    return found.ToArray();
  }

  /** 0-1, or -1 if the app has no audio session yet. */
  public static float Get(string processName) {
    foreach (var v in Find(processName)) { float level; if (v.GetMasterVolume(out level) == 0) return level; }
    return -1;
  }

  public static bool Set(string processName, float level) {
    Guid ctx = Guid.Empty;
    bool any = false;
    foreach (var v in Find(processName)) any |= v.SetMasterVolume(level, ref ctx) == 0;
    return any;
  }
}
'@

# Media session app id -> the process whose audio session to adjust.
function Get-ProcessName([string]$appId) {
  $id = $appId.ToLowerInvariant()
  if ($id -match 'spotify') { return 'Spotify' }
  if ($id -match 'msedge|microsoftedge') { return 'msedge' }
  if ($id -match 'chrome') { return 'chrome' }
  if ($id -match 'firefox|308046b0af4a39cb') { return 'firefox' }
  if ($id -match 'brave') { return 'brave' }
  if ($id -match 'opera') { return 'opera' }
  return ($appId -replace '\.exe$', '' -replace '^.*!', '')
}

# ---------- reading state ----------

# Prefer Spotify when it has a session; otherwise whatever Windows considers current.
function Get-Session {
  foreach ($s in $manager.GetSessions()) {
    if ($s.SourceAppUserModelId -match 'spotify') { return $s }
  }
  return $manager.GetCurrentSession()
}

function Get-Artwork($props) {
  try {
    if ($null -eq $props.Thumbnail) { return '' }
    $stream = Await ($props.Thumbnail.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
    $size = [uint32]$stream.Size
    if ($size -eq 0) { return '' }
    $reader = [Windows.Storage.Streams.DataReader]::new($stream.GetInputStreamAt(0))
    $null = Await ($reader.LoadAsync($size)) ([uint32])
    $bytes = New-Object byte[] $size
    $reader.ReadBytes($bytes)
    $type = $stream.ContentType
    if (-not $type) { $type = 'image/png' }
    return "data:$type;base64," + [Convert]::ToBase64String($bytes)
  } catch { return '' }
}

$script:artworkFor = ''

function Get-State {
  $s = Get-Session
  if ($null -eq $s) { return [ordered]@{ type = 'state'; availability = 'not-running' } }

  $info = $s.GetPlaybackInfo()
  $timeline = $s.GetTimelineProperties()
  $props = Await ($s.TryGetMediaPropertiesAsync()) ($MediaProperties)

  $state = switch ([string]$info.PlaybackStatus) {
    'Playing' { 'playing' }
    'Paused' { 'paused' }
    default { 'stopped' }
  }
  $trackId = "$($props.Title)|$($props.Artist)|$($props.AlbumTitle)"
  $updated = $timeline.LastUpdatedTime.ToUnixTimeMilliseconds()
  if ($updated -le 0) { $updated = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }
  $repeat = $info.AutoRepeatMode
  $process = Get-ProcessName $s.SourceAppUserModelId
  $volume = [ZellampAppVolume]::Get($process)

  $out = [ordered]@{
    type         = 'state'
    availability = 'ok'
    app          = $s.SourceAppUserModelId
    state        = $state
    trackId      = $trackId
    title        = [string]$props.Title
    artist       = [string]$props.Artist
    album        = [string]$props.AlbumTitle
    positionSec  = ($timeline.Position - $timeline.StartTime).TotalSeconds
    durationMs   = [math]::Round(($timeline.EndTime - $timeline.StartTime).TotalMilliseconds)
    sampledAt    = $updated
    shuffling    = ($info.IsShuffleActive -eq $true)
    repeating    = ($null -ne $repeat -and [string]$repeat -ne 'None')
    volume       = $(if ($volume -ge 0) { [math]::Round($volume * 100) } else { -1 })
    canSeek      = [bool]$info.Controls.IsPlaybackPositionEnabled
  }
  # Artwork only when the track changes (it's the expensive part).
  if ($trackId -ne $script:artworkFor) {
    $out.artwork = Get-Artwork $props
    $script:artworkFor = $trackId
  }
  return $out
}

# ---------- commands ----------

function Invoke-MediaCommand($msg) {
  $s = Get-Session
  if ($null -eq $s) { return $false }
  $bool = [bool]
  switch ($msg.cmd) {
    'play'      { return Await ($s.TryPlayAsync()) $bool }
    'pause'     { return Await ($s.TryPauseAsync()) $bool }
    'playpause' { return Await ($s.TryTogglePlayPauseAsync()) $bool }
    'next'      { return Await ($s.TrySkipNextAsync()) $bool }
    'prev'      { return Await ($s.TrySkipPreviousAsync()) $bool }
    'seek'      {
      $ticks = [long]([double]$msg.value * 10000000) + $s.GetTimelineProperties().StartTime.Ticks
      return Await ($s.TryChangePlaybackPositionAsync($ticks)) $bool
    }
    'shuffle'   { return Await ($s.TryChangeShuffleActiveAsync([bool]$msg.value)) $bool }
    'repeat'    {
      $mode = if ($msg.value) { [Windows.Media.MediaPlaybackAutoRepeatMode]::List } else { [Windows.Media.MediaPlaybackAutoRepeatMode]::None }
      return Await ($s.TryChangeAutoRepeatModeAsync($mode)) $bool
    }
    'volume'    {
      $level = [math]::Max(0, [math]::Min(100, [double]$msg.value)) / 100
      return [ZellampAppVolume]::Set((Get-ProcessName $s.SourceAppUserModelId), [float]$level)
    }
  }
  return $false
}

# ---------- main loop: commands from stdin, state out ~4x/s when changed ----------

# Read commands on a background runspace into a queue, from the raw stdin
# stream (not [Console]::In; see the stdout note above). Every stdin read in
# Windows PowerShell 5.1 blocks, even the "Async" ones, so the main loop only
# ever polls the queue.
$queue = New-Object 'System.Collections.Concurrent.ConcurrentQueue[string]'
$reader = [PowerShell]::Create()
$null = $reader.AddScript({
    param($q)
    $in = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), (New-Object System.Text.UTF8Encoding $false))
    while ($null -ne ($line = $in.ReadLine())) { $q.Enqueue($line) }
    $q.Enqueue('__eof__')
  }).AddArgument($queue)
$null = $reader.BeginInvoke()

$last = ''
$nextPoll = [DateTime]::MinValue
# After a command, re-check quickly for a moment: players apply play/pause
# asynchronously, so reading immediately would report the old state.
$burstUntil = [DateTime]::MinValue

while ($true) {
  $line = $null
  while ($queue.TryDequeue([ref]$line)) {
    if ($line -eq '__eof__') { exit 0 } # Zellamp closed our stdin: exit.
    $msg = $null
    try {
      $msg = $line | ConvertFrom-Json
      $ok = Invoke-MediaCommand $msg
      Send @{ type = 'ack'; id = $msg.id; ok = [bool]$ok }
    } catch {
      Send @{ type = 'ack'; id = $(if ($msg) { $msg.id } else { 0 }); ok = $false; error = $_.Exception.Message }
    }
    $burstUntil = [DateTime]::UtcNow.AddMilliseconds(1500)
    $nextPoll = [DateTime]::UtcNow.AddMilliseconds(120)
  }

  if ([DateTime]::UtcNow -ge $nextPoll) {
    $interval = if ([DateTime]::UtcNow -lt $burstUntil) { 120 } else { 250 }
    $nextPoll = [DateTime]::UtcNow.AddMilliseconds($interval)
    try {
      $state = Get-State
      $json = $state | ConvertTo-Json -Compress -Depth 4
      # Emit on change; artwork-bearing states always go out.
      if ($json -ne $last -or $state.Contains('artwork')) {
        $last = $json
        Send-Line $json
      }
    } catch {
      Send @{ type = 'error'; message = $_.Exception.Message }
      Start-Sleep -Milliseconds 500
    }
  }
  Start-Sleep -Milliseconds 30
}
