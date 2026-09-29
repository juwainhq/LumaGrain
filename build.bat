@echo off
setlocal EnableExtensions EnableDelayedExpansion

REM =====================================================================
REM  LumaGrain - ZXP build script (Windows)
REM  Packages the CEP extension into a SIGNED CinemaFX.zxp using Adobe's
REM  ZXPSignCmd tool (self-signed certificate, generated automatically).
REM
REM  Usage:   build.bat
REM  Output:  CinemaFX.zxp  (next to this script)
REM =====================================================================

set "ROOT=%~dp0"
set "STAGE=%ROOT%build\stage"
set "OUT_ZXP=%ROOT%LumaGrain.zxp"
set "CERT_FILE=%ROOT%build\lumagrain-selfsigned.p12"

REM ---- Certificate fields (placeholders - edit to taste) --------------
set "CERT_COUNTRY=US"
set "CERT_STATE=California"
set "CERT_ORG=Film Tools"
set "CERT_NAME=LumaGrain Developer"
set "CERT_PASS=cinemafx2026"

REM =====================================================================
REM  [1/4] Locate ZXPSignCmd.exe (same folder as this script, or on PATH)
REM =====================================================================
echo [1/4] Looking for ZXPSignCmd.exe ...

set "ZXP_TOOL="
REM Prefer the full absolute path (robust against cmd's quoted
REM relative-name resolution); fall back to PATH lookup.
if exist "%ROOT%ZXPSignCmd.exe" (
    set "ZXP_TOOL=%ROOT%ZXPSignCmd.exe"
) else (
    where ZXPSignCmd.exe >nul 2>nul
    if not errorlevel 1 set "ZXP_TOOL=ZXPSignCmd.exe"
)
if not defined ZXP_TOOL (
    echo.
    echo [ERROR] ZXPSignCmd.exe was not found.
    echo         Put ZXPSignCmd.exe next to build.bat, or add it to PATH.
    echo         Download it from Adobe:
    echo         https://github.com/Adobe-CEP/CEP-Resources/tree/master/ZXPSignCMD
    exit /b 1
)
echo        Using: !ZXP_TOOL!

REM =====================================================================
REM  [2/4] Stage a clean copy of the extension (excludes build files)
REM =====================================================================
echo [2/4] Staging extension files ...

if exist "%STAGE%" rmdir /s /q "%STAGE%"
mkdir "%STAGE%" 2>nul

xcopy /e /i /y /q "%ROOT%CSXS"        "%STAGE%\CSXS\"        >nul || goto :fail_stage
xcopy /e /i /y /q "%ROOT%jsx"         "%STAGE%\jsx\"         >nul || goto :fail_stage
xcopy /e /i /y /q "%ROOT%lib"         "%STAGE%\lib\"         >nul || goto :fail_stage
copy  /y "%ROOT%index.html"           "%STAGE%\index.html"   >nul || goto :fail_stage
copy  /y "%ROOT%style.css"            "%STAGE%\style.css"    >nul || goto :fail_stage
copy  /y "%ROOT%main.js"              "%STAGE%\main.js"      >nul || goto :fail_stage
copy  /y "%ROOT%.debug"               "%STAGE%\.debug"       >nul || goto :fail_stage
echo        Staged: CSXS\, jsx\, lib\, index.html, style.css, main.js, .debug

REM ---- Safety gate: never sign a package without the manifest --------
if not exist "%STAGE%\CSXS\manifest.xml" (
    echo.
    echo [ERROR] Staging failed - %STAGE%\CSXS\manifest.xml is missing.
    echo         Refusing to sign an incomplete package.
    exit /b 1
)
echo        Manifest present - package is complete.

REM =====================================================================
REM  [3/4] Create the self-signed certificate (only once)
REM =====================================================================
if exist "%CERT_FILE%" (
    echo [3/4] Reusing existing self-signed certificate ...
) else (
    echo [3/4] Generating self-signed certificate ...
    if not exist "%ROOT%build" mkdir "%ROOT%build"
    "!ZXP_TOOL!" -selfSignedCert %CERT_COUNTRY% %CERT_STATE% "%CERT_ORG%" "%CERT_NAME%" "%CERT_PASS%" "%CERT_FILE%"
    if errorlevel 1 (
        echo.
        echo [ERROR] Certificate generation failed.
        echo         Check that the password is at least 6 characters.
        exit /b 1
    )
    echo        Certificate: %CERT_FILE%
)

REM =====================================================================
REM  [4/4] Sign and package the ZXP
REM =====================================================================
echo [4/4] Signing and packaging LumaGrain.zxp ...

if exist "%OUT_ZXP%" del /q "%OUT_ZXP%"
"!ZXP_TOOL!" -sign "%STAGE%" "%OUT_ZXP%" "%CERT_FILE%" "%CERT_PASS%"
if errorlevel 1 (
    echo.
    echo [ERROR] ZXPSignCmd could not sign the extension.
    exit /b 1
)

echo.
echo =====================================================
echo   SUCCESS: %OUT_ZXP%
echo   Install it with any ZXP installer, then restart
echo   Premiere Pro and open Window ^> Extensions ^> LumaGrain
echo =====================================================
exit /b 0

:fail_stage
echo.
echo [ERROR] Failed to stage extension files.
exit /b 1
