@echo off
REM =========================================
REM 啟動 RFID Server（Windows Terminal + 自動開瀏覽器）
REM 檔名：server_open.bat
REM =========================================

REM 切到此批次檔所在資料夾
cd /d %~dp0

REM ===== 可自訂參數 =====
set PORT=COM5
set BAUD=115200
set WEB_PORT=3000
set ENABLE_WS=1
REM 黑名單（逗號分隔，可空白）
set BLACKLIST=E280F3372000F000135FFABE
REM ======================

echo [INFO] 準備啟動 RFID Server...
echo        PORT=%PORT%  BAUD=%BAUD%  WEB_PORT=%WEB_PORT%
echo        BLACKLIST=%BLACKLIST%
echo.

REM 檢查是否有 Windows Terminal
where wt >nul 2>nul
if %errorlevel%==0 (
  echo [INFO] 偵測到 Windows Terminal，使用 wt 啟動...
  REM 在 Windows Terminal 新分頁執行，並保留視窗
  wt -w 0 nt -d . cmd /k "set BLACKLIST=%BLACKLIST% & node rfid_ws_server.js --port=%PORT% --baud=%BAUD% --web_port=%WEB_PORT% --enable_ws=%ENABLE_WS%"
) else (
  echo [WARN] 找不到 Windows Terminal（wt），改用傳統 cmd 視窗啟動...
  start "RFID Server" cmd /k "set BLACKLIST=%BLACKLIST% & node rfid_ws_server.js --port=%PORT% --baud=%BAUD% --web_port=%WEB_PORT% --enable_ws=%ENABLE_WS%"
)

REM 稍等伺服器起來，再開瀏覽器
timeout /t 2 /nobreak >nul
start "" "http://localhost:%WEB_PORT%/get_uid.htm"

echo [OK] 已嘗試啟動伺服器並開啟瀏覽器。
echo 若未自動開啟，請手動前往： http://localhost:%WEB_PORT%/get_uid.htm
