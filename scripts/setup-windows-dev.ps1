# Setup script for Windows development environment
# This script helps set up the correct Node.js version for Gymnasticon development

# Check if running as administrator
$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Host "Please run this script as Administrator" -ForegroundColor Red
    exit 1
}

# Check if nvm is installed
$nvmPath = "$env:USERPROFILE\AppData\Roaming\nvm"
if (-not (Test-Path $nvmPath)) {
    Write-Host "Installing nvm-windows..." -ForegroundColor Yellow
    
    # Download nvm-windows installer
    $nvmUrl = "https://github.com/coreybutler/nvm-windows/releases/download/1.1.11/nvm-setup.exe"
    $installerPath = "$env:TEMP\nvm-setup.exe"
    
    Invoke-WebRequest -Uri $nvmUrl -OutFile $installerPath
    
    # Run the installer
    Start-Process -FilePath $installerPath -ArgumentList "/SILENT" -Wait
    
    # Refresh environment variables
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
}

# Install Node.js 14
Write-Host "Installing Node.js 14.x..." -ForegroundColor Yellow
nvm install 14.21.3
nvm use 14.21.3

# Install Python 2.7 (required for node-gyp)
Write-Host "Installing Python 2.7..." -ForegroundColor Yellow
$pythonInstaller = "https://www.python.org/ftp/python/2.7.18/python-2.7.18.amd64.msi"
$pythonMsi = "$env:TEMP\python-2.7.18.amd64.msi"
Invoke-WebRequest -Uri $pythonInstaller -OutFile $pythonMsi
Start-Process -FilePath "msiexec.exe" -ArgumentList "/i `"$pythonMsi`" /quiet /norestart ADDLOCAL=ALL" -Wait

# Install Visual C++ Build Tools
Write-Host "Installing Visual C++ Build Tools..." -ForegroundColor Yellow
$buildToolsUrl = "https://aka.ms/vs/17/release/vs_buildtools.exe"
$buildToolsExe = "$env:TEMP\vs_buildtools.exe"
Invoke-WebRequest -Uri $buildToolsUrl -OutFile $buildToolsExe
Start-Process -FilePath $buildToolsExe -ArgumentList "--quiet --wait --norestart --nocache --add Microsoft.VisualStudio.Component.VC.Tools.x86.x64" -Wait

# Install specific node-gyp version compatible with Node 14
Write-Host "Installing node-gyp..." -ForegroundColor Yellow
npm install -g node-gyp@6.1.0

# Clean existing installation
Write-Host "Cleaning project..." -ForegroundColor Yellow
if (Test-Path "node_modules") {
    Remove-Item -Recurse -Force "node_modules"
}
if (Test-Path "package-lock.json") {
    Remove-Item -Force "package-lock.json"
}

# Install project dependencies
Write-Host "Installing project dependencies..." -ForegroundColor Yellow
npm install

Write-Host "`nSetup complete!" -ForegroundColor Green
Write-Host "Node.js version:" -ForegroundColor Yellow
node --version
Write-Host "npm version:" -ForegroundColor Yellow
npm --version

Write-Host "`nTo start debugging:" -ForegroundColor Cyan
Write-Host "1. Close and reopen VSCode" -ForegroundColor White
Write-Host "2. Press F5 to start debugging in bot mode" -ForegroundColor White