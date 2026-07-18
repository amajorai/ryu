@echo off
rem Dev launcher for the browser sidecar (Windows): Core spawns this as
rem RYU_BROWSER_BIN so the electron-vite build runs under `bun dev` with no
rem packaged binary. Args + env pass straight through to electron.
rem Requires `electron-vite build` to have produced out\main\index.js first.
setlocal
set "DIR=%~dp0"
bunx electron "%DIR%..\..\..\apps-store\browser\sidecar\out\main\index.js" %*
