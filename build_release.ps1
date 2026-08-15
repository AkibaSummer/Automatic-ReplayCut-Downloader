$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $RepoRoot

$Package = Get-Content -LiteralPath (Join-Path $RepoRoot 'package.json') -Raw | ConvertFrom-Json
$Version = [string]$Package.version
$ProductName = [string]$Package.build.productName
$ReleaseRoot = [IO.Path]::GetFullPath((Join-Path $RepoRoot 'release'))
$ElectronOutput = [IO.Path]::GetFullPath((Join-Path $ReleaseRoot 'electron\win-unpacked'))
$BundleName = "ReplayManager-v$Version-windows-x64"
$StagingDir = [IO.Path]::GetFullPath((Join-Path $ReleaseRoot $BundleName))
$ZipPath = [IO.Path]::GetFullPath((Join-Path $ReleaseRoot "$BundleName.zip"))
$ZipTempPath = [IO.Path]::GetFullPath((Join-Path $ReleaseRoot "$BundleName.tmp.zip"))

function Assert-ReleaseChild([string]$Candidate) {
    $Prefix = $ReleaseRoot.TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
    if (-not $Candidate.StartsWith($Prefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to modify a path outside the release directory: $Candidate"
    }
}

Assert-ReleaseChild $ElectronOutput
Assert-ReleaseChild $StagingDir
Assert-ReleaseChild $ZipPath
Assert-ReleaseChild $ZipTempPath
New-Item -ItemType Directory -Path $ReleaseRoot -Force | Out-Null
if (Test-Path -LiteralPath $StagingDir) {
    Remove-Item -LiteralPath $StagingDir -Recurse -Force
}
foreach ($OldArchive in @($ZipPath, $ZipTempPath)) {
    if (Test-Path -LiteralPath $OldArchive) {
        Remove-Item -LiteralPath $OldArchive -Force
    }
}

Write-Host '1. Installing locked dependencies...' -ForegroundColor Cyan
npm ci
if ($LASTEXITCODE -ne 0) { throw "Root npm ci failed with exit code $LASTEXITCODE" }
npm --prefix frontend ci
if ($LASTEXITCODE -ne 0) { throw "Frontend npm ci failed with exit code $LASTEXITCODE" }

Write-Host '2. Running release verification...' -ForegroundColor Cyan
npm run verify
if ($LASTEXITCODE -ne 0) { throw "Release verification failed with exit code $LASTEXITCODE" }

Write-Host '3. Building the unpacked Electron application...' -ForegroundColor Cyan
npx electron-builder --win dir --x64
if ($LASTEXITCODE -ne 0) { throw "Electron build failed with exit code $LASTEXITCODE" }
if (-not (Test-Path -LiteralPath $ElectronOutput -PathType Container)) {
    throw "Electron output was not found: $ElectronOutput"
}
if (-not (Test-Path -LiteralPath (Join-Path $ElectronOutput 'resources\app.asar') -PathType Leaf)) {
    throw 'Packaged app.asar was not found in the Electron output'
}
$AppExe = Join-Path $ElectronOutput "$ProductName.exe"
if (-not (Test-Path -LiteralPath $AppExe -PathType Leaf)) {
    throw "Packaged application executable was not found: $AppExe"
}

Write-Host '4. Creating a clean portable bundle...' -ForegroundColor Cyan
Copy-Item -LiteralPath $ElectronOutput -Destination $StagingDir -Recurse

# Runtime state is intentionally never shipped. A fresh app creates defaults next
# to the executable; existing users keep their own config/database/cookies.
$ForbiddenNames = @('config.yaml', 'config.yaml.bak', 'replays.db', 'replays.db-wal', 'replays.db-shm', 'cookies.json')
$LeakedFiles = Get-ChildItem -LiteralPath $StagingDir -Recurse -File |
    Where-Object {
        $ForbiddenNames -contains $_.Name -or
        $_.Name -like '.env*' -or
        $_.Name -like '*.log' -or
        $_.Name -like '*.old' -or
        $_.Name -like '*.tmp'
    }
if ($LeakedFiles) {
    $Names = ($LeakedFiles | ForEach-Object FullName) -join ', '
    throw "Portable bundle unexpectedly contains private runtime data: $Names"
}

$AsarPath = Join-Path $StagingDir 'resources\app.asar'
$AsarCheck = @'
const asar = require('@electron/asar');
const archive = process.argv[1];
const expectedVersion = process.argv[2];
const entries = asar.listPackage(archive);
const forbidden = /(^|[\\/])(config\.yaml(?:\.bak)?|cookies\.json|replays\.db(?:-wal|-shm)?|\.env[^\\/]*|[^\\/]+\.(?:log|old|tmp))$/i;
const leaks = entries.filter(entry => forbidden.test(entry));
if (leaks.length) throw new Error(`private runtime entries in app.asar: ${leaks.join(', ')}`);
const pkg = JSON.parse(asar.extractFile(archive, 'package.json').toString('utf8'));
if (pkg.version !== expectedVersion) throw new Error(`app.asar version ${pkg.version} != ${expectedVersion}`);
'@
& node -e $AsarCheck $AsarPath $Version
if ($LASTEXITCODE -ne 0) { throw 'app.asar validation failed' }

$ExeVersion = (Get-Item -LiteralPath (Join-Path $StagingDir "$ProductName.exe")).VersionInfo.ProductVersion
if ($ExeVersion -and -not $ExeVersion.StartsWith($Version, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Executable version $ExeVersion does not match package version $Version"
}
Compress-Archive -Path (Join-Path $StagingDir '*') -DestinationPath $ZipTempPath -CompressionLevel Optimal
Move-Item -LiteralPath $ZipTempPath -Destination $ZipPath
$Hash = (Get-FileHash -LiteralPath $ZipPath -Algorithm SHA256).Hash.ToLowerInvariant()

Write-Host 'Build completed successfully.' -ForegroundColor Green
Write-Host "Portable directory: $StagingDir" -ForegroundColor Yellow
Write-Host "Portable archive:   $ZipPath" -ForegroundColor Yellow
Write-Host "SHA256:              $Hash" -ForegroundColor Yellow
