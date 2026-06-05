$ErrorActionPreference = "Stop"

$RELEASE_DIR = "release"
$PORTABLE_DIR = Join-Path $RELEASE_DIR "portable"
$PORTABLE_EXE = "ReplayManager-Portable.exe"
$ZIP_NAME = "ReplayManager-Windows-Portable.zip"

Write-Host "1. Cleaning previous release..." -ForegroundColor Cyan
If (Test-Path $RELEASE_DIR) {
    Remove-Item -Recurse -Force $RELEASE_DIR
}
New-Item -ItemType Directory -Path $RELEASE_DIR | Out-Null
New-Item -ItemType Directory -Path $PORTABLE_DIR | Out-Null

Write-Host "2. Installing dependencies..." -ForegroundColor Cyan
if (-not (Test-Path "node_modules")) {
    npm install
    if ($LASTEXITCODE -ne 0) {
        throw "Root npm install failed with exit code $LASTEXITCODE"
    }
} else {
    Write-Host "Using existing root node_modules..." -ForegroundColor Green
}
if (-not (Test-Path "frontend\node_modules")) {
    npm --prefix frontend install
    if ($LASTEXITCODE -ne 0) {
        throw "Frontend npm install failed with exit code $LASTEXITCODE"
    }
} else {
    Write-Host "Using existing frontend node_modules..." -ForegroundColor Green
}

Write-Host "3. Building Electron desktop application..." -ForegroundColor Cyan
npm run dist
if ($LASTEXITCODE -ne 0) {
    throw "Electron build failed with exit code $LASTEXITCODE"
}

$DIST_OUTPUT = Join-Path "release\electron" $PORTABLE_EXE
if (-not (Test-Path $DIST_OUTPUT)) {
    throw "Portable executable not found: $DIST_OUTPUT"
}
Copy-Item -Path $DIST_OUTPUT -Destination (Join-Path $PORTABLE_DIR $PORTABLE_EXE) -Force
Write-Host "Electron portable executable built successfully!" -ForegroundColor Green

Write-Host "4. Copying existing portable data..." -ForegroundColor Cyan
$PORTABLE_FILES = @(
    "config.yaml",
    "replays.db",
    "cookies.json"
)
foreach ($file in $PORTABLE_FILES) {
    if (Test-Path $file) {
        Copy-Item -Path $file -Destination (Join-Path $PORTABLE_DIR $file) -Force
    }
}
if (Test-Path "runtime") {
    Copy-Item -Path "runtime" -Destination $PORTABLE_DIR -Recurse -Force
}

Write-Host "5. Preparing FFmpeg tools..." -ForegroundColor Cyan
$FFMPEG_ZIP = "ffmpeg-release.zip"
if (-not (Test-Path $FFMPEG_ZIP)) {
    throw "Missing ffmpeg bundle: $FFMPEG_ZIP"
}
$FFMPEG_TEMP = Join-Path $RELEASE_DIR "ffmpeg-temp"
if (Test-Path $FFMPEG_TEMP) {
    Remove-Item -Recurse -Force $FFMPEG_TEMP
}
Expand-Archive -Path $FFMPEG_ZIP -DestinationPath $FFMPEG_TEMP -Force
$FFMPEG_EXE = Get-ChildItem -Path $FFMPEG_TEMP -Filter "ffmpeg.exe" -Recurse | Select-Object -First 1
$FFPROBE_EXE = Get-ChildItem -Path $FFMPEG_TEMP -Filter "ffprobe.exe" -Recurse | Select-Object -First 1
if ($null -eq $FFMPEG_EXE -or $null -eq $FFPROBE_EXE) {
    throw "Failed to locate ffmpeg.exe or ffprobe.exe in $FFMPEG_ZIP"
}
Copy-Item -Path $FFMPEG_EXE.FullName -Destination (Join-Path $PORTABLE_DIR "ffmpeg.exe") -Force
Copy-Item -Path $FFPROBE_EXE.FullName -Destination (Join-Path $PORTABLE_DIR "ffprobe.exe") -Force
Remove-Item -Recurse -Force $FFMPEG_TEMP

Write-Host "6. Zipping final release..." -ForegroundColor Cyan
$ZIP_PATH = Join-Path $RELEASE_DIR $ZIP_NAME
If (Test-Path $ZIP_PATH) {
    Remove-Item -Force $ZIP_PATH
}
Compress-Archive -Path "$PORTABLE_DIR\*" -DestinationPath $ZIP_PATH

Write-Host "===============================================" -ForegroundColor Green
Write-Host "✅ Build completed successfully! " -ForegroundColor Green
Write-Host "📁 The portable bundle is located at: $ZIP_PATH" -ForegroundColor Yellow
Write-Host "===============================================" -ForegroundColor Green
