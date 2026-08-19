@echo off
setlocal EnableExtensions DisableDelayedExpansion

set "NVM_HOME="
set "NVM_SYMLINK="

rem 1) Prefer the exact path already on PATH in this command shell
where nvm >nul 2>nul
if not errorlevel 1 (
  for /f "delims=" %%I in ('where nvm 2^>nul') do (
    set "NVM_HOME=%%~dpI"
    set "NVM_HOME=!NVM_HOME:~0,-1!"
    goto :nvm_found
  )
)

rem 2) Search common install locations
for %%D in (
  "%LOCALAPPDATA%\nvm"
  "%APPDATA%\nvm"
  "%USERPROFILE%\AppData\Roaming\nvm"
  "%USERPROFILE%\AppData\Local\nvm"
  "C:\Program Files\nvm"
  "C:\Program Files (x86)\nvm"
  "D:\Program Files\nvm"
  "E:\Program Files\nvm"
  "F:\Program Files\nvm"
  "C:\tools\nvm"
  "D:\tools\nvm"
  "E:\tools\nvm"
) do (
  if exist "%%~D\nvm.exe" (
    set "NVM_HOME=%%~D"
    goto :nvm_found
  )
)

rem 3) Final fallback: scan local drives for nvm.exe
for %%D in (C D E F G H I J K L M N O P Q R S T U V W X Y Z) do (
  if exist "%%D:\nvm\nvm.exe" (
    set "NVM_HOME=%%D:\nvm"
    goto :nvm_found
  )
  if exist "%%D:\Program Files\nvm\nvm.exe" (
    set "NVM_HOME=%%D:\Program Files\nvm"
    goto :nvm_found
  )
  if exist "%%D:\Users\%USERNAME%\AppData\Roaming\nvm\nvm.exe" (
    set "NVM_HOME=%%D:\Users\%USERNAME%\AppData\Roaming\nvm"
    goto :nvm_found
  )
)

:nvm_found
if not defined NVM_HOME (
  echo NVM for Windows not found.
  echo Please install it first, then double-click this launcher again.
  echo Typical install directory: %%LOCALAPPDATA%%\nvm
  echo Or re-open the shell where 'nvm list' already works.
  pause
  exit /b 1
)

if exist "%ProgramFiles%\nodejs" (
  set "NVM_SYMLINK=%ProgramFiles%\nodejs"
) else if exist "%ProgramW6432%\nodejs" (
  set "NVM_SYMLINK=%ProgramW6432%\nodejs"
) else if exist "%ProgramFiles(x86)%\nodejs" (
  set "NVM_SYMLINK=%ProgramFiles(x86)%\nodejs"
) else (
  set "NVM_SYMLINK=%NVM_HOME%"
)

set "PATH=%NVM_HOME%;%NVM_SYMLINK%;%PATH%"
set "NVM_HOME=%NVM_HOME%"
set "NVM_SYMLINK=%NVM_SYMLINK%"

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0launch.ps1" %*
pause