# 🚀 Shiba Log Server

독립적인 로그 수집 및 저장 서버입니다. 메인 애플리케이션과 분리되어 운영되므로 시스템 안정성을 향상시킵니다.

## ✨ 주요 기능

- 🔄 **배치 처리**: 메모리 버퍼를 통한 효율적인 로그 배치 저장
- 📊 **파티션 테이블**: 월별 자동 파티션으로 성능 최적화
- 🛡️ **내결함성**: 실패 시 자동 재시도 메커니즘
- 🔐 **보안**: API 키 기반 인증
- 📈 **모니터링**: 실시간 서버 상태 및 통계 제공
- 🧹 **자동 정리**: 오래된 로그 데이터 자동 정리

## 🏗️ 설치 및 설정

### 1. 의존성 설치

```bash
cd log-server
npm install
# 또는
yarn install
```

### 2. 환경변수 설정

`.env` 파일을 생성하고 다음 내용을 입력하세요:

```bash
# 서버 설정
PORT=3002
NODE_ENV=production

# 데이터베이스 설정
SHIBA_LOG_DATABASE_URL=postgresql://username:password@localhost:5432/shiba_logs

# API 인증 (강력한 키 사용 권장)
SHIBA_LOG_API_KEY=your-super-secret-api-key-here

# 로그 처리 설정
LOG_BATCH_SIZE=1000
LOG_FLUSH_INTERVAL_MS=60000

# 데이터 정리 설정 (개월)
DATA_RETENTION_MONTHS=6

# CORS 설정 (선택사항)
ALLOWED_ORIGINS=http://localhost:3000,http://localhost:3001
```

### 3. 데이터베이스 준비

PostgreSQL 데이터베이스를 준비하고 연결 정보를 환경변수에 설정하세요.

## 🚀 실행

### 개발 모드
```bash
npm run dev
```

### 프로덕션 모드
```bash
npm start
```

## 📡 API 엔드포인트

모든 `/api/logs` 엔드포인트는 `x-api-key` 헤더가 필요합니다.

### 기본 정보
- **GET** `/` - 서버 정보 조회

### 로그 관리
- **POST** `/api/logs` - 단일 로그 저장
- **POST** `/api/logs/batch` - 배치 로그 저장 (최대 1000개)
- **GET** `/api/logs` - 로그 조회 (필터링 지원)

### 서버 관리
- **GET** `/api/logs/health` - 헬스체크
- **GET** `/api/logs/stats` - 서버 통계 조회
- **POST** `/api/logs/flush` - 강제 버퍼 플러시
- **POST** `/api/logs/cleanup` - 오래된 데이터 정리

## 🔧 사용 예시

### 단일 로그 저장
```bash
curl -X POST http://localhost:3002/api/logs \
  -H "Content-Type: application/json" \
  -H "x-api-key: your-api-key" \
  -d '{
    "type": "user_action",
    "level": "info",
    "message": "사용자가 로그인했습니다",
    "metadata": {
      "user_id": 123,
      "ip": "192.168.1.1"
    }
  }'
```

### 배치 로그 저장
```bash
curl -X POST http://localhost:3002/api/logs/batch \
  -H "Content-Type: application/json" \
  -H "x-api-key: your-api-key" \
  -d '{
    "logs": [
      {
        "type": "game_event",
        "level": "info",
        "message": "게임 시작",
        "metadata": {"game_id": 456}
      },
      {
        "type": "game_event",
        "level": "info",
        "message": "게임 종료",
        "metadata": {"game_id": 456, "duration": 1800}
      }
    ]
  }'
```

### 로그 조회
```bash
curl -X GET "http://localhost:3002/api/logs?type=user_action&level=info&page=1&limit=50" \
  -H "x-api-key: your-api-key"
```

### 서버 상태 확인
```bash
curl -X GET http://localhost:3002/api/logs/health \
  -H "x-api-key: your-api-key"
```

## 📊 로그 데이터 구조

```json
{
  "type": "string",        // 필수: 로그 유형
  "level": "string",       // 선택: info, warn, error, debug (기본값: info)
  "message": "string",     // 필수: 로그 메시지
  "metadata": "object",    // 선택: 추가 메타데이터
  "timestamp": "datetime"  // 자동 생성: 로그 생성 시간
}
```

## 🔄 배치 처리 메커니즘

1. **메모리 버퍼**: 로그가 메모리 버퍼에 임시 저장
2. **트리거 조건**:
   - 버퍼 크기가 설정값 도달 (기본: 1000개)
   - 주기적 플러시 (기본: 60초)
3. **배치 저장**: PostgreSQL에 일괄 삽입
4. **실패 처리**: 실패 시 버퍼에 재삽입하여 재시도

## 🛡️ 보안 고려사항

- **API 키**: 강력한 API 키 사용 권장
- **CORS**: 필요한 도메인만 허용
- **HTTPS**: 프로덕션 환경에서는 HTTPS 사용 권장
- **방화벽**: 필요한 포트만 개방

## 📈 성능 최적화

- **파티션 테이블**: 월별 자동 파티션으로 쿼리 성능 향상
- **인덱스**: timestamp, type, level 필드에 인덱스 설정
- **연결 풀**: PostgreSQL 연결 풀링 (최대 20개 연결)
- **압축**: HTTP 응답 압축 활성화

## 🔧 모니터링

### 헬스체크
```bash
curl http://localhost:3002/api/logs/health -H "x-api-key: your-key"
```

### 통계 조회
```bash
curl http://localhost:3002/api/logs/stats -H "x-api-key: your-key"
```

## 🐳 Docker 사용 (선택사항)

### Dockerfile 예시
```dockerfile
FROM node:18-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY src ./src

EXPOSE 3002

CMD ["npm", "start"]
```

### docker-compose.yml 예시
```yaml
version: '3.8'
services:
  log-server:
    build: .
    ports:
      - "3002:3002"
    environment:
      - NODE_ENV=production
      - SHIBA_LOG_DATABASE_URL=postgresql://user:pass@postgres:5432/logs
      - SHIBA_LOG_API_KEY=your-secure-key
    depends_on:
      - postgres
      
  postgres:
    image: postgres:15
    environment:
      POSTGRES_DB: logs
      POSTGRES_USER: user
      POSTGRES_PASSWORD: pass
    volumes:
      - postgres_data:/var/lib/postgresql/data

volumes:
  postgres_data:
```

## 🚦 운영 가이드

### 시작/중지
```bash
# 시작
npm start

# 중지 (Graceful shutdown)
Ctrl+C 또는 SIGTERM/SIGINT 시그널
```

### 로그 모니터링
```bash
# 실시간 로그 확인
tail -f /path/to/log/file

# PM2 사용 시
pm2 logs log-server
```

### 백업 및 복구
```bash
# 데이터베이스 백업
pg_dump -h localhost -U username -d shiba_logs > backup.sql

# 복구
psql -h localhost -U username -d shiba_logs < backup.sql
```

## 🆘 문제 해결

### 일반적인 문제

1. **연결 오류**: 데이터베이스 URL 및 네트워크 확인
2. **인증 실패**: API 키 확인
3. **메모리 부족**: 배치 크기 조정
4. **성능 저하**: 인덱스 및 파티션 확인

### 로그 레벨
- `info`: 일반 정보
- `warn`: 경고
- `error`: 오류
- `debug`: 디버그 정보

## 📄 라이선스

MIT License

## 🤝 기여

버그 리포트, 기능 요청, 풀 리퀘스트를 환영합니다!

---

**주의**: 프로덕션 환경에서는 적절한 보안 설정과 모니터링을 구성하세요. 