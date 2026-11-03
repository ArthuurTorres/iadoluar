@echo off
setlocal enabledelayedexpansion

echo ========================================
echo   ia-sdr-pousada - Dev Environment
echo ========================================
echo.

:: Step 1: Verify .env exists
if not exist ".env" (
    echo [!] .env not found. Copying from .env.example...
    if exist ".env.example" (
        copy ".env.example" ".env" >nul
        echo [OK] .env created from .env.example
    ) else (
        echo [ERROR] .env.example not found. Cannot proceed.
        pause
        exit /b 1
    )
) else (
    echo [OK] .env already exists
)

:: Step 2: Verify Docker is available
where docker >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Docker is not installed or not in PATH.
    echo         Please install Docker Desktop for Windows:
    echo         https://www.docker.com/products/docker-desktop/
    pause
    exit /b 1
)

docker compose version >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Docker Compose is not available.
    echo         Please update Docker Desktop to the latest version.
    pause
    exit /b 1
)
echo [OK] Docker Compose is available

:: Step 3: Start container
echo.
echo [*] Starting containers with docker compose...
docker compose up -d
if %errorlevel% neq 0 (
    echo [ERROR] Failed to start containers. Check docker compose logs.
    pause
    exit /b 1
)
echo [OK] Containers started

:: Step 4: Wait for health check (max 30 seconds)
echo.
echo [*] Waiting for health check at http://localhost:4000/health ...
set /a attempts=0
set /a max_attempts=30

:health_loop
if %attempts% geq %max_attempts% (
    echo [ERROR] Health check timed out after %max_attempts% seconds.
    echo         Run 'docker compose logs' to diagnose.
    pause
    exit /b 1
)

curl -s -o nul -w "%%{http_code}" http://localhost:4000/health >nul 2>&1
if %errorlevel% equ 0 (
    for /f %%i in ('curl -s -o nul -w "%%{http_code}" http://localhost:4000/health 2^>nul') do set httpcode=%%i
    if "!httpcode!"=="200" goto :health_ok
)

set /a attempts+=1
timeout /t 1 /nobreak >nul
goto :health_loop

:health_ok
echo [OK] Health check passed

:: Step 5: Enable AI via admin toggle
echo.
echo [*] Enabling AI via POST /admin/toggle ...

:: Read ADMIN_TOKEN from .env
for /f "tokens=1,* delims==" %%a in ('findstr /b "ADMIN_TOKEN=" .env') do set ADMIN_TOKEN=%%b

curl -s -X POST http://localhost:4000/admin/toggle ^
    -H "x-admin-token: %ADMIN_TOKEN%" ^
    -H "Content-Type: application/json" >nul 2>&1

:: Verify AI is enabled
for /f "delims=" %%r in ('curl -s http://localhost:4000/admin/status -H "x-admin-token: %ADMIN_TOKEN%" 2^>nul') do set status_response=%%r
echo %status_response% | findstr /c:"\"enabled\":true" >nul 2>&1
if %errorlevel% equ 0 (
    echo [OK] AI enabled successfully
) else (
    echo [WARN] Could not confirm AI enabled. Response: %status_response%
)

:: Done
echo.
echo ========================================
echo   Server running at http://localhost:4000
echo   Health:  http://localhost:4000/health
echo   Admin:   http://localhost:4000/admin/status
echo   Logs:    docker compose logs -f
echo ========================================
echo.
echo Press any key to stop containers...
pause >nul

echo.
echo [*] Stopping containers...
docker compose down
echo [OK] Containers stopped.

endlocal