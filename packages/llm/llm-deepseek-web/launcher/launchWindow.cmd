@echo off
rem 双击入口（Windows）：实现在 launch.ps1，本文件只负责把它跑起来。
rem 双击 .ps1 默认用记事本打开，所以必须由 .cmd 承担双击入口。
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0launch.ps1" %*
