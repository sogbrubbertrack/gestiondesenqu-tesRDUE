@echo off
setlocal
cd /d "%~dp0"
for /f %%P in ('powershell.exe -NoProfile -Command "$p=4177; $free=$false; while(-not $free){$l=[System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback,$p); try{$l.Start();$l.Stop();$free=$true}catch{$p++}}; Write-Output $p"') do set "APP_PORT=%%P"
if not defined APP_PORT set "APP_PORT=4177"
start "RubberWay Archives - serveur local" /D "%~dp0" cmd /k "set PORT=%APP_PORT% && node server.js"
timeout /t 3 /nobreak >nul
start "" http://127.0.0.1:%APP_PORT%
endlocal
