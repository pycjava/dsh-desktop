# Appends <dsh-home>\bin to the user PATH (HKCU\Environment), preserving
# unexpanded REG_EXPAND_SZ tokens, then broadcasts WM_SETTINGCHANGE so newly
# opened terminals see it without logging off. Idempotent — including against
# the *other spelling* of the same dir (%USERPROFILE% token vs expanded).
# Shared by the NSIS installer (build/installer.nsh) and the app's
# launch-time self-heal (src/ensure-cli-shim.cjs, which passes the dir via
# $env:DSH_BIN_DIR to honor a $DSH_HOME override).
$ErrorActionPreference = 'Stop'
$defaultDir = Join-Path $env:USERPROFILE '.dsh\bin'
$defaultToken = '%USERPROFILE%\.dsh\bin'
if ($env:DSH_BIN_DIR) {
  $dir = $env:DSH_BIN_DIR
  # The default home is stored as the unexpanded token so the entry survives
  # profile moves; a $DSH_HOME override has no token form and goes in literal.
  $token = if ($dir -ieq $defaultDir) { $defaultToken } else { $dir }
} else {
  $dir = $defaultDir
  $token = $defaultToken
}
$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
try {
  $raw = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
  $parts = @($raw -split ';' | Where-Object { $_ -ne '' })
  $known = @($defaultToken, $dir) | Where-Object { $_ -ne $token }
  $present = $false
  foreach ($p in $parts) {
    if ($p -ieq $token -or $known -contains $p) { $present = $true; break }
  }
  if (-not $present) {
    $new = if ($raw.Trim()) { $raw.TrimEnd(';') + ';' + $token } else { $token }
    $key.SetValue('Path', $new, [Microsoft.Win32.RegistryValueKind]::ExpandString)
    Write-Output "dsh: appended $token to user PATH"
  }
} finally { $key.Close() }
$sig = @'
[DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
public static extern System.IntPtr SendMessageTimeout(System.IntPtr hWnd, uint Msg, System.UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out System.UIntPtr lpdwResult);
'@
$nm = Add-Type -MemberDefinition $sig -Name 'NativeMethods' -Namespace 'DshWin32' -PassThru
[UIntPtr]$result = [UIntPtr]::Zero
[void]$nm::SendMessageTimeout([System.IntPtr]0xFFFF, 0x1A, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$result)
