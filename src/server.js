import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import dotenv from 'dotenv';
import swaggerUi from 'swagger-ui-express';
import { logRequest, errorHandler } from './middleware/auth.js';
import { createPartitionTable, testConnection, startPartitionScheduler } from './config/database.js';
import { swaggerSpec } from './config/swagger.js';
import logsRouter from './routes/logs.js';

// 환경변수 로드
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3002;

// 서버 시작 시간 기록
const serverStartTime = new Date();

// 미들웨어 설정
app.use(helmet({
  contentSecurityPolicy: false, // API 서버이므로 비활성화
}));

app.use(cors({
  origin: '*',  // 모든 도메인에서 접근 허용 (게임에서 어떤 URL인지 모르므로)
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key'],
}));

app.use(compression());
app.use(express.json({ limit: '10mb' })); // 대용량 로그 배치 처리를 위한 크기 증가
app.use(express.urlencoded({ extended: true }));

// 요청 로깅 미들웨어
app.use(logRequest);

// Swagger 설정
const swaggerOptions = {
  customCss: `
    .swagger-ui .topbar { display: none }
    .swagger-ui .info { margin: 20px 0; }
    .swagger-ui .info .title { color: #1890ff; }
  `,
  customSiteTitle: 'Shiba Log Server API',
  customfavIcon: '/favicon.ico',
  swaggerOptions: {
    persistAuthorization: true,
    displayRequestDuration: true,
    docExpansion: 'list',
    filter: true,
    showRequestHeaders: true,
    tryItOutEnabled: true
  }
};

// API 문서 라우트
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec, swaggerOptions));

// 라우터 설정
app.use('/api/logs', logsRouter);

// 루트 엔드포인트 - API 문서로 리다이렉트
app.get('/', (req, res) => {
  res.redirect('/api-docs');
});

// 404 핸들러
app.use('*', (req, res) => {
  res.status(404).json({
    error: '엔드포인트를 찾을 수 없습니다',
    message: `${req.method} ${req.originalUrl}은(는) 존재하지 않는 엔드포인트입니다`,
    availableEndpoints: [
      'GET /api-docs - API 문서',
      'POST /api/logs - 로그 저장',
      'GET /api/logs - 로그 조회',
      'GET /api/logs/partitions - 파티션 목록',
      'POST /api/logs/batch - 배치 로그 저장',
      'POST /api/logs/flush - 강제 플러시',
      'GET /api/logs/stats - 서버 통계',
      'GET /api/logs/health - 헬스체크',
      'POST /api/logs/cleanup - 데이터 정리'
    ]
  });
});

// 에러 핸들러
app.use(errorHandler);

// 서버 시작 함수
async function startServer() {
  try {
    console.log('🚀 Shiba Log Server 시작 중...');
    
    // 환경변수 검증
    if (!process.env.SHIBA_LOG_DATABASE_URL) {
      console.error('❌ SHIBA_LOG_DATABASE_URL 환경변수가 설정되지 않았습니다');
      process.exit(1);
    }
    
    if (!process.env.SHIBA_LOG_API_KEY) {
      console.error('❌ SHIBA_LOG_API_KEY 환경변수가 설정되지 않았습니다');
      process.exit(1);
    }

    // 데이터베이스 연결 테스트
    console.log('🔌 데이터베이스 연결 테스트 중...');
    const isConnected = await testConnection();
    if (!isConnected) {
      console.error('❌ 데이터베이스 연결 실패');
      process.exit(1);
    }

    // 파티션 테이블 생성
    console.log('📊 파티션 테이블 설정 중...');
    await createPartitionTable();

    // 파티션 스케줄러 시작
    console.log('📅 파티션 스케줄러 시작 중...');
    await startPartitionScheduler();

    // 서버 시작
    const server = app.listen(PORT, () => {
      console.log('');
      console.log('🎉 =================================');
      console.log('✅ Shiba Log Server 시작 완료!');
      console.log(`🌐 서버 주소: http://localhost:${PORT}`);
      console.log(`🔧 환경: ${process.env.NODE_ENV || 'development'}`);
      console.log(`📦 Node.js 버전: ${process.version}`);
      console.log(`⏰ 시작 시간: ${serverStartTime.toISOString()}`);
      console.log('🎉 =================================');
      console.log('');
      console.log('📋 사용 가능한 엔드포인트:');
      console.log('   GET  /api-docs - API 문서');
      console.log('   POST /api/logs - 로그 저장');
      console.log('   GET  /api/logs - 로그 조회');
      console.log('   GET  /api/logs/partitions - 파티션 목록');
      console.log('   POST /api/logs/batch - 배치 로그 저장');
      console.log('   POST /api/logs/flush - 강제 플러시');
      console.log('   GET  /api/logs/stats - 서버 통계');
      console.log('   GET  /api/logs/health - 헬스체크');
      console.log('   POST /api/logs/cleanup - 데이터 정리');
      console.log('');
      console.log('🔑 모든 /api/logs 엔드포인트는 x-api-key 헤더가 필요합니다.');
      console.log('');
    });

    // Graceful shutdown 처리
    const gracefulShutdown = async (signal) => {
      console.log(`\n⚠️  ${signal} 시그널 수신 - 서버 종료 준비 중...`);
      
      server.close(async () => {
        console.log('🔄 HTTP 서버 종료됨');
        
        try {
          // 로그 메모리 스토어 플러시
          const { logMemoryStore } = await import('./services/log-memory-store.js');
          console.log('💾 남은 로그 플러시 중...');
          await logMemoryStore.forceFlush();
          await logMemoryStore.clearBuffer();
          console.log('✅ 로그 플러시 완료');
        } catch (error) {
          console.error('❌ 로그 플러시 중 에러:', error);
        }
        
        console.log('👋 서버가 안전하게 종료되었습니다');
        process.exit(0);
      });

      // 30초 후 강제 종료
      setTimeout(() => {
        console.error('❌ 강제 종료됨 (타임아웃)');
        process.exit(1);
      }, 30000);
    };

    // 시그널 핸들러 등록
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));

  } catch (error) {
    console.error('❌ 서버 시작 실패:', error);
    process.exit(1);
  }
}

// 처리되지 않은 에러 캐치
process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error);
  process.exit(1);
});

// 서버 시작
startServer(); 