$ErrorActionPreference = "Stop"

$RELEASE_DIR = "release"
$APP_NAME = "BilibiliReplayManager.exe"
$FFMPEG_ZIP = "ffmpeg-release.zip"
$FFMPEG_URL = "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip"

Write-Host "1. Cleaning previous release..." -ForegroundColor Cyan
If (Test-Path $RELEASE_DIR) {
    Remove-Item -Recurse -Force $RELEASE_DIR
}
New-Item -ItemType Directory -Path $RELEASE_DIR | Out-Null

Write-Host "2. Building Frontend (Vite & React)..." -ForegroundColor Cyan
Push-Location frontend
npm install
npm run build
Pop-Location

Write-Host "3. Copying Frontend compiled static assets..." -ForegroundColor Cyan
$DEST_FRONTEND_DIR = Join-Path $RELEASE_DIR "frontend/dist"
New-Item -ItemType Directory -Path $DEST_FRONTEND_DIR -Force | Out-Null
Copy-Item -Path "frontend/dist\*" -Destination $DEST_FRONTEND_DIR -Recurse

Write-Host "4. Compiling Go Backend Engine..." -ForegroundColor Cyan
$ENV:CGO_ENABLED = "1"
$ENV:GOOS = "windows"
$ENV:GOARCH = "amd64"
go build -ldflags="-w -s" -o "$RELEASE_DIR/$APP_NAME" cmd/main.go
Write-Host "Go engine compiled successfully!" -ForegroundColor Green

Write-Host "5. Downloading FFmpeg executable..." -ForegroundColor Cyan
Write-Host "Downloading from Github ($FFMPEG_URL)... This may take a minute."
Invoke-WebRequest -Uri $FFMPEG_URL -OutFile $FFMPEG_ZIP

Write-Host "Extracting FFmpeg..."
Expand-Archive -Path $FFMPEG_ZIP -DestinationPath "temp_ffmpeg" -Force

$FFMPEG_EXE = Get-ChildItem -Path "temp_ffmpeg" -Filter "ffmpeg.exe" -Recurse | Select-Object -First 1
Copy-Item $FFMPEG_EXE.FullName -Destination "$RELEASE_DIR/ffmpeg.exe"

Remove-Item -Recurse -Force "temp_ffmpeg"
Remove-Item -Force $FFMPEG_ZIP

Write-Host "6. Zipping Final Release..." -ForegroundColor Cyan
$ZIP_NAME = "BilibiliReplayManager_Windows_Bundle.zip"
If (Test-Path $ZIP_NAME) {
    Remove-Item -Force $ZIP_NAME
}
Compress-Archive -Path "$RELEASE_DIR\*" -DestinationPath $ZIP_NAME

Write-Host "===============================================" -ForegroundColor Green
Write-Host "✅ Build completed successfully! " -ForegroundColor Green
Write-Host "📁 The standalone bundle is located at: $ZIP_NAME" -ForegroundColor Yellow
Write-Host "===============================================" -ForegroundColor Green
