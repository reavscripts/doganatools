@echo off
setlocal EnableExtensions

REM =====================================================
REM CLOUDFLARE TUNNEL - DOGANATOOLS
REM Tunnel:  utilitydogana
REM Dominio: https://dogana-api.reav.website
REM Servizio locale configurato: http://localhost:3000
REM =====================================================

set "APP_DIR=C:\DoganaTools"
set "TUNNEL_NAME=utilitydogana"
set "CONFIG_FILE=%USERPROFILE%\.cloudflared\config.yaml"
set "LOG_DIR=%APP_DIR%\logs"
set "LOG_FILE=%LOG_DIR%\cloudflared-tunnel.log"

if not exist "%LOG_DIR%" mkdir "%LOG_DIR%" >nul 2>&1

if not exist "%CONFIG_FILE%" (
  >"%LOG_FILE%" echo ERRORE: file di configurazione non trovato: "%CONFIG_FILE%"
  exit /b 2
)

set "CF_BIN="
for /f "delims=" %%I in ('where cloudflared.exe 2^>nul') do if not defined CF_BIN set "CF_BIN=%%I"

if not defined CF_BIN if exist "%ProgramFiles%\cloudflared\cloudflared.exe" set "CF_BIN=%ProgramFiles%\cloudflared\cloudflared.exe"
if not defined CF_BIN if exist "%ProgramFiles%\Cloudflare\cloudflared.exe" set "CF_BIN=%ProgramFiles%\Cloudflare\cloudflared.exe"
if not defined CF_BIN if exist "%LOCALAPPDATA%\Microsoft\WinGet\Links\cloudflared.exe" set "CF_BIN=%LOCALAPPDATA%\Microsoft\WinGet\Links\cloudflared.exe"

if not defined CF_BIN (
  >"%LOG_FILE%" echo ERRORE: cloudflared.exe non trovato nel PATH o nei percorsi standard.
  exit /b 3
)

cd /d "%APP_DIR%" || (
  >"%LOG_FILE%" echo ERRORE: cartella non trovata: "%APP_DIR%"
  exit /b 4
)

REM Attende che il backend Node pianificato abbia il tempo di avviarsi.
timeout /t 30 /nobreak >nul

>"%LOG_FILE%" echo Avvio tunnel %TUNNEL_NAME%...
>>"%LOG_FILE%" echo Configurazione: %CONFIG_FILE%
>>"%LOG_FILE%" echo Eseguibile: %CF_BIN%
>>"%LOG_FILE%" echo.

"%CF_BIN%" tunnel --config "%CONFIG_FILE%" run "%TUNNEL_NAME%" >>"%LOG_FILE%" 2>&1
set "EXIT_CODE=%ERRORLEVEL%"

>>"%LOG_FILE%" echo.
>>"%LOG_FILE%" echo cloudflared terminato con codice %EXIT_CODE%.
exit /b %EXIT_CODE%
