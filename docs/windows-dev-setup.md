npm config set python "C:\Python27\python.exe"
npm config set python "C:\Python27\python.exe".\scripts\setup-windows-dev.ps1# Windows Development Setup Guide

This guide helps you set up your Windows development environment for Gymnasticon, ensuring compatibility with the Raspberry Pi Zero target platform.

## Prerequisites

1. Windows 10 or 11
2. PowerShell with Administrator rights
3. Visual Studio Code
4. Git for Windows

## Setup Instructions

### 1. Open PowerShell as Administrator
- Right-click on PowerShell
- Select "Run as Administrator"

### 2. Navigate to Project Directory
```powershell
cd path\to\gymnasticonV2
```

### 3. Run Setup Script
```powershell
.\scripts\setup-windows-dev.ps1
```

This script will:
- Install nvm-windows (Node Version Manager)
- Install Node.js 14.21.3 (compatible with RPi Zero)
- Install required build tools
- Set up project dependencies

### 4. Verify Installation
After setup completes, you should see:
- Node.js version: v14.21.3
- npm version: 6.x or 8.x

### 5. Development in VSCode

#### Debugging
1. Open VSCode
2. Press F5 to start debugging
3. Select "Debug Gymnasticon (Bot Mode)"

#### Available Debug Configurations
- **Bot Mode**: Simulates a bike with fixed power/cadence
- **Auto-detect**: Searches for real bike hardware
- **Run Tests**: Executes the test suite

## Common Issues

### Native Module Build Errors
If you see errors about node-gyp or native modules:
1. Ensure Visual Studio Build Tools are installed
2. Run as Administrator:
```powershell
npm install -g node-gyp@8.4.1
npm install -g windows-build-tools@5.2.2 --vs2015
```

### Node.js Version Mismatch
If VSCode uses the wrong Node.js version:
1. Close VSCode completely
2. In PowerShell:
```powershell
nvm use 14.21.3
```
3. Reopen VSCode

## Development Tips

1. Always use Node.js 14.21.3 for development to maintain compatibility
2. Test with the bot mode first before trying real hardware
3. Use WSL for Linux-specific testing
4. Keep build tools and dependencies up to date

## WSL Development

For WSL development, see the WSL-specific guide in `README-WSL.md`.