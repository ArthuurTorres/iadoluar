@echo off
chcp 65001 >nul 2>&1
setlocal enabledelayedexpansion

:MENU
cls
echo ============================================================
echo DEPLOY - IA SDR POUSADA
echo ============================================================
echo.
echo [1] Atualizar codigo (copia src + public)
echo [2] Rebuild completo (reconstroi container)
echo [3] Ver logs do container
echo [4] Ativar IA
echo [5] Desativar IA
echo.
echo ============================================================
set /p escolha="Digite sua opcao (1-5): "
if "%escolha%"=="1" goto SYNC
if "%escolha%"=="2" goto REBUILD
if "%escolha%"=="3" goto LOGS
if "%escolha%"=="4" goto ATIVAR_IA
if "%escolha%"=="5" goto DESATIVAR_IA
echo.
echo [ERRO] Opcao invalida.
pause
goto MENU

:SYNC
cls
echo ============================================================
echo ATUALIZANDO CODIGO...
echo ============================================================
echo.
scp -r ./src root@85.31.60.226:~/ia-sdr-pousada/src
if %errorlevel% neq 0 (
    echo [ERRO] Falha ao copiar src.
    pause
    goto MENU
)
scp -r ./public root@85.31.60.226:~/ia-sdr-pousada/public
if %errorlevel% neq 0 (
    echo [ERRO] Falha ao copiar public.
    pause
    goto MENU
)
echo.
echo [OK] Codigo atualizado! Reiniciando container...
ssh root@85.31.60.226 "cd ~/ia-sdr-pousada && docker compose restart"
echo.
echo ============================================================
echo Pronto! Container reiniciado.
echo ============================================================
pause
goto MENU

:REBUILD
cls
echo ============================================================
echo REBUILD COMPLETO...
echo ============================================================
echo.
ssh root@85.31.60.226 "cd ~/ia-sdr-pousada && docker compose up -d --build"
if %errorlevel% neq 0 (
    echo [ERRO] Falha no rebuild.
    pause
    goto MENU
)
echo.
echo ============================================================
echo Rebuild concluido!
echo ============================================================
pause
goto MENU

:LOGS
cls
echo ============================================================
echo LOGS (Ctrl+C para parar)
echo ============================================================
echo.
ssh root@85.31.60.226 "cd ~/ia-sdr-pousada && docker compose logs -f"
pause
goto MENU

:ATIVAR_IA
cls
echo ============================================================
echo ATIVANDO IA...
echo ============================================================
echo.
call :CARREGAR_TOKEN
if "!ADMIN_TOKEN!"=="" (
    echo [ERRO] ADMIN_TOKEN nao encontrado no .env
    echo Adicione ADMIN_TOKEN=seu_token no arquivo .env
    echo.
    pause
    goto MENU
)
echo Consultando status da IA...
call :HTTP_GET "http://85.31.60.226:4000/admin/status" "%TEMP%\ia_status.txt" "!ADMIN_TOKEN!"
if "!HTTP_CODE!"=="000" (
    echo [ERRO] Nao foi possivel conectar ao servidor.
    echo Verifique se o container esta rodando.
    echo.
    pause
    goto MENU
)
if not "!HTTP_CODE!"=="200" (
    echo [ERRO] Falha ao consultar status da IA ^(HTTP !HTTP_CODE!^).
    echo.
    pause
    goto MENU
)
findstr /C:"\"enabled\":true" "%TEMP%\ia_status.txt" >nul 2>nul
if not errorlevel 1 (
    echo [OK] IA ja esta ativada!
    echo.
    del "%TEMP%\ia_status.txt" 2>nul
    pause
    goto MENU
)
del "%TEMP%\ia_status.txt" 2>nul
echo Ativando IA...
call :HTTP_POST "http://85.31.60.226:4000/admin/toggle" "%TEMP%\toggle_result.txt" "!ADMIN_TOKEN!"
if "!HTTP_CODE!"=="000" (
    echo [ERRO] Nao foi possivel conectar ao servidor.
    echo.
    pause
    goto MENU
)
if not "!HTTP_CODE!"=="200" (
    echo [ERRO] Falha ao ativar a IA ^(HTTP !HTTP_CODE!^).
    type "%TEMP%\toggle_result.txt" 2>nul
    echo.
    del "%TEMP%\toggle_result.txt" 2>nul
    pause
    goto MENU
)
findstr /C:"\"enabled\":true" "%TEMP%\toggle_result.txt" >nul 2>nul
if errorlevel 1 (
    echo [ERRO] Resposta inesperada ao ativar a IA.
    type "%TEMP%\toggle_result.txt" 2>nul
) else (
    echo [OK] IA ativada com sucesso!
)
echo.
del "%TEMP%\toggle_result.txt" 2>nul
pause
goto MENU

:DESATIVAR_IA
cls
echo ============================================================
echo DESATIVANDO IA...
echo ============================================================
echo.
call :CARREGAR_TOKEN
if "!ADMIN_TOKEN!"=="" (
    echo [ERRO] ADMIN_TOKEN nao encontrado no .env
    echo Adicione ADMIN_TOKEN=seu_token no arquivo .env
    echo.
    pause
    goto MENU
)
echo Consultando status da IA...
call :HTTP_GET "http://85.31.60.226:4000/admin/status" "%TEMP%\ia_status.txt" "!ADMIN_TOKEN!"
if "!HTTP_CODE!"=="000" (
    echo [ERRO] Nao foi possivel conectar ao servidor.
    echo.
    pause
    goto MENU
)
if not "!HTTP_CODE!"=="200" (
    echo [ERRO] Falha ao consultar status da IA ^(HTTP !HTTP_CODE!^).
    echo.
    pause
    goto MENU
)
findstr /C:"\"enabled\":true" "%TEMP%\ia_status.txt" >nul 2>nul
if errorlevel 1 (
    echo [OK] IA ja esta desativada!
    echo.
    del "%TEMP%\ia_status.txt" 2>nul
    pause
    goto MENU
)
del "%TEMP%\ia_status.txt" 2>nul
echo Desativando IA...
call :HTTP_POST "http://85.31.60.226:4000/admin/toggle" "%TEMP%\toggle_result.txt" "!ADMIN_TOKEN!"
if "!HTTP_CODE!"=="000" (
    echo [ERRO] Nao foi possivel conectar ao servidor.
    echo.
    pause
    goto MENU
)
if not "!HTTP_CODE!"=="200" (
    echo [ERRO] Falha ao desativar a IA ^(HTTP !HTTP_CODE!^).
    type "%TEMP%\toggle_result.txt" 2>nul
    echo.
    del "%TEMP%\toggle_result.txt" 2>nul
    pause
    goto MENU
)
findstr /C:"\"enabled\":true" "%TEMP%\toggle_result.txt" >nul 2>nul
if not errorlevel 1 (
    echo [ERRO] Resposta inesperada ao desativar a IA.
    type "%TEMP%\toggle_result.txt" 2>nul
) else (
    echo [OK] IA desativada com sucesso!
)
echo.
del "%TEMP%\toggle_result.txt" 2>nul
pause
goto MENU

:CARREGAR_TOKEN
set ADMIN_TOKEN=
set ENV_FILE=%~dp0.env
if not exist "!ENV_FILE!" set ENV_FILE=%~dp0..\..\.env
if not exist "!ENV_FILE!" set ENV_FILE=C:\Users\Arthur\iadoluar\.claude\worktrees\ia-sdr-pousada\.env
if exist "!ENV_FILE!" (
    for /f "usebackq tokens=1,* delims==" %%a in ("!ENV_FILE!") do (
        if "%%a"=="ADMIN_TOKEN" set ADMIN_TOKEN=%%b
    )
)
goto :eof

:HTTP_GET
set HTTP_URL=%~1
set HTTP_OUT=%~2
set HTTP_TKN=%~3
set HTTP_CODE=000
curl -s -o "!HTTP_OUT!" -w "%%{http_code}" -H "x-admin-token: !HTTP_TKN!" "!HTTP_URL!" > "%TEMP%\_http_code.txt" 2>nul
set /p HTTP_CODE=<"%TEMP%\_http_code.txt"
del "%TEMP%\_http_code.txt" 2>nul
goto :eof

:HTTP_POST
set HTTP_URL=%~1
set HTTP_OUT=%~2
set HTTP_TKN=%~3
set HTTP_CODE=000
curl -s -o "!HTTP_OUT!" -w "%%{http_code}" -X POST -H "x-admin-token: !HTTP_TKN!" "!HTTP_URL!" > "%TEMP%\_http_code.txt" 2>nul
set /p HTTP_CODE=<"%TEMP%\_http_code.txt"
del "%TEMP%\_http_code.txt" 2>nul
goto :eof