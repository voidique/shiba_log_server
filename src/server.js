import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import dotenv from 'dotenv';
import swaggerUi from 'swagger-ui-express';
import { logRequest, errorHandler } from './middleware/auth.js';
import { createPartitionTable, testConnection, startPartitionScheduler, getCurrentTableName, startConnectionMonitoring, stopConnectionMonitoring, addTimestampFields, migrateAllPartitions, verifySystemHealth, autoRepairSystem } from './config/database.js';
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
      'POST /api/logs/batch - 배치 로그 저장',
      'POST /api/logs/flush - 강제 플러시',
      'GET /api/logs/stats - 서버 통계',
      'GET /api/logs/health - 헬스체크',
      'GET /api/logs/partitions - 파티션 목록',
      'GET /api/logs/current-table - 현재 테이블 정보',
      'POST /api/logs/cleanup - 데이터 정리',
      'POST /api/logs/switch-to-partitioned - 파티션 테이블 전환',
      'POST /api/logs/switch-to-legacy - 레거시 테이블 전환',
      'POST /api/logs/retry-failed - 실패한 로그 재시도',
      'GET /api/logs/failed - 실패한 로그 목록 조회',
      'GET /api/logs/pending - 처리 중인 로그 목록 조회',
      'GET /api/logs/system/verify - 시스템 상태 검증',
      'POST /api/logs/system/repair - 시스템 자동 복구'
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
    
    const hasKey1 = !!process.env.SHIBA_LOG_API_KEY;
    const hasKey2 = !!process.env.SHIBA_LOG_API_KEY2;
    if (!hasKey1 && !hasKey2) {
      console.error('❌ SHIBA_LOG_API_KEY 또는 SHIBA_LOG_API_KEY2 환경변수 중 하나는 설정되어야 합니다');
      process.exit(1);
    }
    if (hasKey1 && hasKey2) {
      console.log('🔑 API 키 로테이션 모드 활성화 (KEY, KEY2 동시 허용)');
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

    // 시스템 상태 검증 및 자동 복구
    console.log('🔍 시스템 상태 검증 중...');
    const isHealthy = await verifySystemHealth();
    
    if (!isHealthy) {
      console.log('⚠️  시스템 문제 발견 - 자동 복구 시작...');
      const repaired = await autoRepairSystem();
      
      if (!repaired) {
        console.error('❌ 시스템 자동 복구 실패 - 수동 개입이 필요할 수 있습니다');
        // 하지만 서버는 계속 실행합니다
      }
    }

    // 파티션 스케줄러 시작
    console.log('📅 파티션 스케줄러 시작 중...');
    await startPartitionScheduler();

    // 데이터베이스 연결 상태 모니터링 시작
    console.log('🔍 데이터베이스 연결 상태 모니터링 시작...');
    startConnectionMonitoring();

    // 서버 시작
    const server = app.listen(PORT, () => {
      const currentTable = getCurrentTableName();
      console.log('');
      console.log('🎉 =================================');
      console.log('✅ Shiba Log Server 시작 완료!');
      console.log(`🌐 서버 주소: http://localhost:${PORT}`);
      console.log(`🔧 환경: ${process.env.NODE_ENV || 'development'}`);
      console.log(`📦 Node.js 버전: ${process.version}`);
      console.log(`⏰ 시작 시간: ${serverStartTime.toISOString()}`);
      console.log(`🗄️  사용 테이블: ${currentTable}`);
      console.log('🎉 =================================');
      console.log('');
      console.log('📋 사용 가능한 엔드포인트:');
      console.log('   GET  /api-docs - API 문서');
      console.log('   POST /api/logs - 로그 저장');
      console.log('   GET  /api/logs - 로그 조회');
      console.log('   POST /api/logs/batch - 배치 로그 저장');
      console.log('   POST /api/logs/flush - 강제 플러시');
      console.log('   GET  /api/logs/stats - 서버 통계');
      console.log('   GET  /api/logs/health - 헬스체크');
      console.log('   GET  /api/logs/partitions - 파티션 목록');
      console.log('   GET  /api/logs/current-table - 현재 테이블 정보');
      console.log('   POST /api/logs/cleanup - 데이터 정리');
      console.log('   POST /api/logs/switch-to-partitioned - 파티션 테이블 전환');
      console.log('   POST /api/logs/switch-to-legacy - 레거시 테이블 전환');
      console.log('   POST /api/logs/retry-failed - 실패한 로그 재시도');
      console.log('   GET  /api/logs/failed - 실패한 로그 목록 조회');
      console.log('   GET  /api/logs/pending - 처리 중인 로그 목록 조회');
      console.log('   GET  /api/logs/system/verify - 시스템 상태 검증');
      console.log('   POST /api/logs/system/repair - 시스템 자동 복구');
      console.log('');
      console.log('🔑 모든 /api/logs 엔드포인트는 x-api-key 헤더가 필요합니다.');
      console.log('');
    });

    // 개선된 Graceful shutdown 처리
    const gracefulShutdown = async (signal) => {
      console.log(`\n⚠️  ${signal} 시그널 수신 - 안전한 서버 종료 시작...`);
      
      let shutdownTimeout = null;
      
      // 최대 60초 후 강제 종료 (기존 30초에서 증가)
      shutdownTimeout = setTimeout(() => {
        console.error('❌ 강제 종료됨 (60초 타임아웃)');
        process.exit(1);
      }, 60000);
      
      try {
        // 1. 새로운 요청 수락 중단
        server.close(async () => {
          console.log('🔄 HTTP 서버 종료됨 - 새로운 요청 수락 중단');
          
          try {
            // 2. 데이터베이스 연결 모니터링 중단
            console.log('🔍 데이터베이스 모니터링 중단 중...');
            stopConnectionMonitoring();
            
            // 3. 로그 메모리 스토어 안전 종료
            const { logMemoryStore } = await import('./services/log-memory-store.js');
            
            console.log('💾 버퍼된 로그들 안전하게 저장 중...');
            console.log(`📊 현재 상태: 버퍼 ${logMemoryStore.getBufferSize()}개, 처리 중: ${logMemoryStore.isProcessing()}`);
            
            // 현재 처리 중인 작업이 있다면 대기
            let waitCount = 0;
            while (logMemoryStore.isProcessing() && waitCount < 30) {
              console.log(`⏳ 현재 처리 중인 작업 완료 대기... (${waitCount + 1}/30초)`);
              await new Promise(resolve => setTimeout(resolve, 1000));
              waitCount++;
            }
            
            // 강제 플러시 실행 (여러 번 시도)
            let flushAttempts = 0;
            const maxFlushAttempts = 5;
            
            while (logMemoryStore.getBufferSize() > 0 && flushAttempts < maxFlushAttempts) {
              console.log(`🔥 강제 플러시 시도 ${flushAttempts + 1}/${maxFlushAttempts} - 남은 로그: ${logMemoryStore.getBufferSize()}개`);
              await logMemoryStore.forceFlush();
              flushAttempts++;
              
              // 잠시 대기
              if (logMemoryStore.getBufferSize() > 0) {
                await new Promise(resolve => setTimeout(resolve, 1000));
              }
            }
            
            // 최종 상태 확인
            const finalStats = logMemoryStore.getStats();
            console.log('📊 최종 로그 처리 통계:', {
              bufferSize: finalStats.bufferSize,
              totalProcessed: finalStats.totalProcessed,
              totalFailed: finalStats.totalFailed,
              successRate: finalStats.successRate,
              pendingLogs: finalStats.pendingLogsCount,
              permanentlyFailedLogs: finalStats.permanentlyFailedLogsCount
            });
            
            if (finalStats.bufferSize > 0) {
              console.warn(`⚠️  ${finalStats.bufferSize}개 로그가 저장되지 않았습니다. 실패한 로그 정보:`);
              const failedLogs = logMemoryStore.getFailedLogs();
              if (failedLogs.length > 0) {
                console.warn(`💀 영구 실패한 로그 ${failedLogs.length}개:`, 
                  failedLogs.map(log => ({
                    id: log.logId?.slice(0, 8),
                    type: log.type,
                    retryCount: log.retryCount,
                    reason: log.finalFailureReason
                  }))
                );
              }
            } else {
              console.log('✅ 모든 로그가 성공적으로 저장되었습니다');
            }
            
            // 버퍼 클리어
            await logMemoryStore.clearBuffer();
            console.log('✅ 로그 메모리 스토어 정리 완료');
            
          } catch (error) {
            console.error('❌ 안전한 종료 중 에러:', error);
          }
          
          // 타임아웃 클리어
          if (shutdownTimeout) {
            clearTimeout(shutdownTimeout);
          }
          
          console.log('👋 서버가 안전하게 종료되었습니다');
          process.exit(0);
        });
        
      } catch (error) {
        console.error('❌ Graceful shutdown 중 에러:', error);
        if (shutdownTimeout) {
          clearTimeout(shutdownTimeout);
        }
        process.exit(1);
      }
    };

    // 시그널 핸들러 등록
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));

  } catch (error) {
    console.error('❌ 서버 시작 실패:', error);
    process.exit(1);
  }
}

// 처리되지 않은 에러 캐치 (개선됨)
process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection 감지:', {
    reason: reason?.message || reason,
    stack: reason?.stack,
    promise: promise.toString().slice(0, 100)
  });
  // 즉시 종료하지 않고 로깅만 함 (로그 손실 방지)
});

process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception 감지:', {
    message: error.message,
    stack: error.stack,
    timestamp: new Date().toISOString()
  });
  
  // 치명적 에러이므로 graceful shutdown 시도
  console.log('🚨 치명적 에러로 인한 안전한 종료 시작...');
  
  setTimeout(() => {
    console.error('❌ 강제 종료됨 (uncaught exception 후 타임아웃)');
    process.exit(1);
  }, 10000);
  
  // graceful shutdown 시도
  process.emit('SIGTERM');
});

// 서버 시작
startServer(); 
