@echo off
echo 🚀 Shiba Log Database Backup 시작...
echo.

REM 환경변수 체크
if "%SHIBA_LOG_DATABASE_URL%"=="" (
    echo ❌ SHIBA_LOG_DATABASE_URL 환경변수가 설정되지 않았습니다.
    echo 📋 .env 파일에서 환경변수를 확인해주세요.
    pause
    exit /b 1
)

REM Node.js 스크립트 실행
node backup-database.js

echo.
echo ✅ 백업 프로세스 완료
pause 