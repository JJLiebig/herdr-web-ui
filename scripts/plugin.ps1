# Herdr may have started before Bun was installed: read the current user PATH at invocation time.
param([string]$Command = 'status')
$ErrorActionPreference = 'Stop'
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$env:PATH = "$env:USERPROFILE\.bun\bin;$userPath;$env:PATH"
& bun (Join-Path $PSScriptRoot 'plugin.ts') $Command
exit $LASTEXITCODE
