# Uninstall counterpart of install-cli-path.ps1: drops the dsh shim dir from
# the user PATH (both the %USERPROFILE% token and the expanded spelling,
# case-insensitively), leaving every other entry — including unexpanded
# tokens — untouched, then broadcasts WM_SETTINGCHANGE.
$ErrorActionPreference = 'Stop'
$tokens = @('%USERPROFILE%\.dsh\bin', (Join-Path $env:USERPROFILE '.dsh\bin'))
$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
try {
  $raw = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
  $kept = @($raw -split ';' | Where-Object { $_ -ne '' -and $tokens -notcontains $_ })
  $new = $kept -join ';'
  if ($new -ne $raw) {
    if ($new) { $key.SetValue('Path', $new, [Microsoft.Win32.RegistryValueKind]::ExpandString) }
    else { $key.DeleteValue('Path', $false) }
    Write-Output 'dsh: removed shim dir from user PATH'
  }
} finally { $key.Close() }
$sig = @'
[DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
public static extern System.IntPtr SendMessageTimeout(System.IntPtr hWnd, uint Msg, System.UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out System.UIntPtr lpdwResult);
'@
$nm = Add-Type -MemberDefinition $sig -Name 'NativeMethods' -Namespace 'DshWin32' -PassThru
[UIntPtr]$result = [UIntPtr]::Zero
[void]$nm::SendMessageTimeout([System.IntPtr]0xFFFF, 0x1A, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$result)
