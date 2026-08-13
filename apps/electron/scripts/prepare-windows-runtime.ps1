$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true

$appRoot = Split-Path -Parent $PSScriptRoot
$runtimeRoot = Join-Path $appRoot '.runtime'
$nodeCommand = Get-Command node -CommandType Application | Select-Object -First 1
if ($null -eq $nodeCommand -or [System.IO.Path]::GetExtension($nodeCommand.Source) -ne '.exe') {
  throw 'prepare-windows-runtime: node.exe was not found on PATH.'
}

$nodePath = $nodeCommand.Source
$nodeDirectory = Split-Path -Parent $nodePath
$licensePath = Join-Path $nodeDirectory 'LICENSE'
if (-not (Test-Path -LiteralPath $licensePath -PathType Leaf)) {
  throw "prepare-windows-runtime: Node license not found at $licensePath"
}

$nodeVersion = & $nodePath -p 'process.versions.node'
$nodeArch = & $nodePath -p 'process.arch'
if ($nodeArch -ne 'x64') {
  throw "prepare-windows-runtime: Windows x64 packaging requires an x64 Node runtime, found $nodeArch."
}

New-Item -ItemType Directory -Path $runtimeRoot -Force | Out-Null
$runtimeNode = Join-Path $runtimeRoot 'node.exe'
Copy-Item -LiteralPath $nodePath -Destination $runtimeNode -Force
Copy-Item -LiteralPath $licensePath -Destination (Join-Path $runtimeRoot 'LICENSE') -Force

$metadata = [ordered]@{
  nodeVersion = $nodeVersion
  architecture = $nodeArch
  sha256 = (Get-FileHash -LiteralPath $runtimeNode -Algorithm SHA256).Hash.ToLowerInvariant()
}
$metadata | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $runtimeRoot 'runtime.json') -Encoding UTF8
Write-Output "Prepared Node $nodeVersion ($nodeArch) at $runtimeNode"
