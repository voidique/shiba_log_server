import express from 'express';
import { logMemoryStore } from '../services/log-memory-store.js';
import { queryLogs, cleanupOldData, getPartitionList, getCurrentTableName, switchToPartitionedTable, switchToLegacyTable } from '../config/database.js';
import { validateApiKey } from '../middleware/auth.js';

const router = express.Router();

// 모든 로그 관련 엔드포인트에 API 키 인증 적용
router.use(validateApiKey);

/**
 * @swagger
 * /api/logs:
 *   post:
 *     summary: 단일 로그 저장
 *     description: 단일 로그 엔트리를 저장합니다.
 *     tags:
 *       - Logs
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/LogEntry'
 *           examples:
 *             user_action:
 *               summary: 사용자 액션 로그
 *               value:
 *                 type: "user_action"
 *                 message: "사용자가 로그인했습니다"
 *                 level: "info"
 *                 metadata:
 *                   userId: 12345
 *                   sessionId: "abc123"
 *                   ip: "192.168.1.1"
 *             error_log:
 *               summary: 에러 로그
 *               value:
 *                 type: "error"
 *                 message: "데이터베이스 연결 실패"
 *                 level: "error"
 *                 metadata:
 *                   errorCode: "DB_CONNECTION_FAILED"
 *                   stack: "Error: Connection timeout..."
 *     responses:
 *       200:
 *         description: 로그 저장 성공
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SuccessResponse'
 *       400:
 *         description: 잘못된 요청
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       401:
 *         description: 인증 실패
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       500:
 *         description: 서버 에러
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
// POST /api/logs - 로그 저장
router.post('/', async (req, res) => {
  try {
    const logData = req.body;

    // 필수 필드 검증
    if (!logData.type || !logData.message) {
      return res.status(400).json({
        error: '필수 필드가 누락되었습니다',
        message: 'type과 message 필드는 필수입니다',
        required: ['type', 'message']
      });
    }

    // 로그 데이터 유효성 검사
    if (typeof logData.type !== 'string' || logData.type.trim() === '') {
      return res.status(400).json({
        error: 'type 필드는 비어있지 않은 문자열이어야 합니다'
      });
    }

    if (typeof logData.message !== 'string' || logData.message.trim() === '') {
      return res.status(400).json({
        error: 'message 필드는 비어있지 않은 문자열이어야 합니다'
      });
    }

    // 로그 레벨 기본값 설정
    if (!logData.level) {
      logData.level = 'info';
    }

    // 메타데이터 처리
    if (logData.metadata && typeof logData.metadata !== 'object') {
      return res.status(400).json({
        error: 'metadata 필드는 객체 타입이어야 합니다'
      });
    }

    await logMemoryStore.addLog(logData);
    
    res.json({ 
      success: true,
      message: '로그가 성공적으로 저장되었습니다',
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('로그 저장 실패:', error);
    res.status(500).json({
      error: '로그 저장에 실패했습니다',
      message: error.message
    });
  }
});

/**
 * @swagger
 * /api/logs/batch:
 *   post:
 *     summary: 배치 로그 저장
 *     description: 여러 로그 엔트리를 한 번에 저장합니다. (최대 1000개)
 *     tags:
 *       - Logs
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/BatchLogRequest'
 *           example:
 *             logs:
 *               - type: "user_action"
 *                 message: "사용자가 로그인했습니다"
 *                 level: "info"
 *                 metadata:
 *                   userId: 12345
 *               - type: "system"
 *                 message: "서버가 시작되었습니다"
 *                 level: "info"
 *     responses:
 *       200:
 *         description: 배치 로그 저장 성공
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/SuccessResponse'
 *                 - type: object
 *                   properties:
 *                     count:
 *                       type: integer
 *                       description: 저장된 로그 개수
 *       400:
 *         description: 잘못된 요청
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       401:
 *         description: 인증 실패
 *       500:
 *         description: 서버 에러
 */
// POST /api/logs/batch - 배치 로그 저장
router.post('/batch', async (req, res) => {
  try {
    const { logs } = req.body;

    if (!Array.isArray(logs)) {
      return res.status(400).json({
        error: 'logs 필드는 배열이어야 합니다'
      });
    }

    if (logs.length === 0) {
      return res.status(400).json({
        error: '최소 1개 이상의 로그가 필요합니다'
      });
    }

    if (logs.length > 1000) {
      return res.status(400).json({
        error: '한 번에 최대 1000개의 로그만 처리할 수 있습니다'
      });
    }

    // 각 로그 유효성 검사
    const invalidLogs = [];
    logs.forEach((log, index) => {
      if (!log.type || !log.message) {
        invalidLogs.push(`로그 ${index}: type과 message 필드 필수`);
      }
    });

    if (invalidLogs.length > 0) {
      return res.status(400).json({
        error: '유효하지 않은 로그들이 있습니다',
        details: invalidLogs
      });
    }

    // 모든 로그를 메모리 스토어에 추가
    for (const log of logs) {
      if (!log.level) log.level = 'info';
      await logMemoryStore.addLog(log);
    }

    res.json({
      success: true,
      message: `${logs.length}개의 로그가 성공적으로 저장되었습니다`,
      count: logs.length,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('배치 로그 저장 실패:', error);
    res.status(500).json({
      error: '배치 로그 저장에 실패했습니다',
      message: error.message
    });
  }
});

/**
 * @swagger
 * /api/logs:
 *   get:
 *     summary: 로그 조회
 *     description: 필터링 조건에 따라 로그를 조회합니다. 메모리 버퍼와 데이터베이스 모두에서 조회합니다.
 *     tags:
 *       - Logs
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: type
 *         schema:
 *           type: string
 *         description: 로그 타입으로 필터링
 *       - in: query
 *         name: level
 *         schema:
 *           type: string
 *           enum: [debug, info, warn, error]
 *         description: 로그 레벨로 필터링
 *       - in: query
 *         name: message
 *         schema:
 *           type: string
 *         description: 메시지로 필터링 (부분 일치)
 *       - in: query
 *         name: startDate
 *         schema:
 *           type: string
 *           format: date-time
 *         description: 시작 날짜 (ISO 8601 형식)
 *       - in: query
 *         name: endDate
 *         schema:
 *           type: string
 *           format: date-time
 *         description: 종료 날짜 (ISO 8601 형식)
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           minimum: 1
 *           default: 1
 *         description: 페이지 번호
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 1000
 *           default: 50
 *         description: 페이지당 항목 수 (최대 1000)
 *     responses:
 *       200:
 *         description: 로그 조회 성공
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/LogsQueryResponse'
 *       401:
 *         description: 인증 실패
 *       500:
 *         description: 서버 에러
 */
// GET /api/logs - 로그 조회
router.get('/', async (req, res) => {
  try {
    const filters = {
      type: req.query.type || undefined,
      level: req.query.level || undefined,
      message: req.query.message || undefined,
      startDate: req.query.startDate ? new Date(req.query.startDate) : undefined,
      endDate: req.query.endDate ? new Date(req.query.endDate) : undefined,
      page: parseInt(req.query.page) || 1,
      limit: Math.min(parseInt(req.query.limit) || 50, 1000), // 최대 1000개 제한
      sortBy: req.query.sortBy || 'combined' // 'combined', 'memory', 'database'
    };

    // 메모리에서 로그 조회 (버퍼된 로그들)
    const memoryResult = logMemoryStore.getStoredLogs(filters);

    // DB에서 로그 조회 (이미 저장된 로그들)
    let dbResult = null;
    let dbLogs = [];
    try {
      const offset = (filters.page - 1) * filters.limit;
      const queryResult = await queryLogs({
        ...filters,
        offset
      });
      
      dbLogs = queryResult.map(({ total_count, ...log }) => ({
        ...log,
        source: 'database'
      }));
      
      dbResult = {
        records: dbLogs,
        total: queryResult.length > 0 ? queryResult[0].total_count : 0,
        page: filters.page,
        totalPages: queryResult.length > 0 ? Math.ceil(queryResult[0].total_count / filters.limit) : 0
      };
    } catch (dbError) {
      console.error('DB 로그 조회 중 에러:', dbError);
      dbResult = {
        records: [],
        total: 0,
        page: filters.page,
        totalPages: 0
      };
    }

    // 통합 정렬된 결과 생성
    let combinedLogs = [];
    if (filters.sortBy === 'combined') {
      // 메모리와 DB 로그를 시간순으로 통합 정렬
      const memoryLogs = memoryResult.records.filter(log => !log.total_count); // 메모리 로그만 필터링
      combinedLogs = logMemoryStore.mergeAndSortLogs(
        memoryLogs, 
        dbLogs, 
        filters.limit
      );
    }

    const responseData = {
      success: true,
      data: {
        // 통합 정렬 결과 (기본)
        combined: {
          records: combinedLogs,
          total: memoryResult.total + (dbResult?.total || 0),
          totalMemoryLogs: memoryResult.total,
          totalDatabaseLogs: dbResult?.total || 0,
          bufferSize: logMemoryStore.getBufferSize(),
          sortedBy: 'created_at_desc'
        },
        // 개별 결과 (필요시 참조용)
        memory: memoryResult,
        database: dbResult,
        // 메타 정보
        meta: {
          query: filters,
          timestamp: new Date().toISOString(),
          explanation: {
            created_at: '로그가 생성된 시간 (클라이언트 요청 시간)',
            logged_at: '로그가 DB에 실제 저장된 시간',
            source: 'memory: 아직 처리되지 않은 버퍼 로그, database: 이미 저장된 로그'
          }
        }
      }
    };

    res.json(responseData);

  } catch (error) {
    console.error('로그 조회 실패:', error);
    res.status(500).json({
      error: '로그 조회에 실패했습니다',
      message: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

/**
 * @swagger
 * /api/logs/flush:
 *   post:
 *     summary: 강제 플러시
 *     description: 메모리 버퍼의 모든 로그를 즉시 데이터베이스에 저장합니다.
 *     tags:
 *       - Management
 *     security:
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: 플러시 성공
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/SuccessResponse'
 *                 - type: object
 *                   properties:
 *                     processed:
 *                       type: integer
 *                       description: 처리된 로그 개수
 *                     remainingBuffer:
 *                       type: integer
 *                       description: 남은 버퍼 크기
 *       401:
 *         description: 인증 실패
 *       500:
 *         description: 서버 에러
 */
// POST /api/logs/flush - 강제 플러시
router.post('/flush', async (req, res) => {
  try {
    const bufferSizeBefore = logMemoryStore.getBufferSize();
    await logMemoryStore.forceFlush();
    const bufferSizeAfter = logMemoryStore.getBufferSize();
    
    res.json({
      success: true,
      message: '버퍼 플러시가 완료되었습니다',
      processed: bufferSizeBefore - bufferSizeAfter,
      remainingBuffer: bufferSizeAfter,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('강제 플러시 실패:', error);
    res.status(500).json({
      error: '강제 플러시에 실패했습니다',
      message: error.message
    });
  }
});

/**
 * @swagger
 * /api/logs/stats:
 *   get:
 *     summary: 서버 통계 조회
 *     description: 서버 운영 상태와 로그 스토어 통계 정보를 조회합니다.
 *     tags:
 *       - Monitoring
 *     security:
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: 통계 조회 성공
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/StatsResponse'
 *       401:
 *         description: 인증 실패
 *       500:
 *         description: 서버 에러
 */
// GET /api/logs/stats - 서버 통계 조회
router.get('/stats', async (req, res) => {
  try {
    const stats = logMemoryStore.getStats();
    
    res.json({
      success: true,
      data: {
        server: {
          uptime: process.uptime(),
          memoryUsage: process.memoryUsage(),
          nodeVersion: process.version,
          environment: process.env.NODE_ENV || 'development',
          currentTable: getCurrentTableName()
        },
        logStore: {
          ...stats,
          // 추가 정보
          pendingLogs: logMemoryStore.getPendingLogs().length,
          failedLogs: logMemoryStore.getFailedLogs().length,
          healthStatus: stats.successRate === '100%' ? 'healthy' : 
                       parseFloat(stats.successRate) > 95 ? 'warning' : 'critical'
        },
        database: {
          connectionString: process.env.SHIBA_LOG_DATABASE_URL ? 'Connected' : 'Not configured'
        },
        // 새로운 상세 통계
        performance: {
          averageBufferSize: stats.bufferSize,
          processingEfficiency: stats.isProcessing ? 'busy' : 'idle',
          lastProcessedAt: stats.lastProcessedAt,
          retryRate: stats.totalFailed > 0 ? 
            ((stats.totalFailed / (stats.totalProcessed + stats.totalFailed)) * 100).toFixed(2) + '%' : '0%'
        }
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('통계 조회 실패:', error);
    res.status(500).json({
      error: '통계 조회에 실패했습니다',
      message: error.message
    });
  }
});

/**
 * @swagger
 * /api/logs/cleanup:
 *   post:
 *     summary: 오래된 데이터 정리
 *     description: 지정된 기간보다 오래된 로그 데이터를 삭제합니다.
 *     tags:
 *       - Management
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/CleanupRequest'
 *           example:
 *             months: 6
 *     responses:
 *       200:
 *         description: 데이터 정리 성공
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/SuccessResponse'
 *                 - type: object
 *                   properties:
 *                     monthsKept:
 *                       type: integer
 *                       description: 보관된 개월 수
 *       400:
 *         description: 잘못된 요청
 *       401:
 *         description: 인증 실패
 *       500:
 *         description: 서버 에러
 */
// POST /api/logs/cleanup - 오래된 데이터 정리
router.post('/cleanup', async (req, res) => {
  try {
    const monthsToKeep = parseInt(req.body.months) || 6;
    
    if (monthsToKeep < 1 || monthsToKeep > 24) {
      return res.status(400).json({
        error: '보관 기간은 1-24개월 사이여야 합니다'
      });
    }

    await cleanupOldData(monthsToKeep);
    
    res.json({
      success: true,
      message: `${monthsToKeep}개월 이전 데이터 정리가 완료되었습니다`,
      monthsKept: monthsToKeep,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('데이터 정리 실패:', error);
    res.status(500).json({
      error: '데이터 정리에 실패했습니다',
      message: error.message
    });
  }
});

/**
 * @swagger
 * /api/logs/health:
 *   get:
 *     summary: 헬스체크
 *     description: 서버의 상태를 확인합니다.
 *     tags:
 *       - Monitoring
 *     security:
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: 서버 상태 정상
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/HealthResponse'
 *       401:
 *         description: 인증 실패
 */
// GET /api/logs/health - 헬스체크
router.get('/health', (req, res) => {
  const stats = logMemoryStore.getStats();
  const failedLogs = logMemoryStore.getFailedLogs();
  const pendingLogs = logMemoryStore.getPendingLogs();
  
  // 헬스 상태 결정
  let healthStatus = 'healthy';
  let issues = [];
  
  // 버퍼 크기가 너무 크면 경고
  if (stats.bufferSize > stats.batchSize * 2) {
    healthStatus = 'warning';
    issues.push('버퍼 크기가 큽니다');
  }
  
  // 실패율이 높으면 경고/위험
  const successRate = parseFloat(stats.successRate);
  if (successRate < 95 && successRate > 90) {
    healthStatus = 'warning';
    issues.push('로그 실패율이 높습니다');
  } else if (successRate <= 90) {
    healthStatus = 'critical';
    issues.push('로그 실패율이 매우 높습니다');
  }
  
  // 영구 실패한 로그가 있으면 경고
  if (failedLogs.length > 0) {
    healthStatus = healthStatus === 'healthy' ? 'warning' : healthStatus;
    issues.push(`${failedLogs.length}개 로그가 영구 실패했습니다`);
  }
  
  // 처리가 너무 오래 걸리면 경고
  const now = Date.now();
  const oldestPendingLog = pendingLogs.reduce((oldest, log) => {
    return log.processingStartedAt < oldest ? log.processingStartedAt : oldest;
  }, now);
  
  if (pendingLogs.length > 0 && (now - oldestPendingLog) > 30000) { // 30초 이상
    healthStatus = 'warning';
    issues.push('로그 처리가 지연되고 있습니다');
  }
  
  res.json({
    status: healthStatus,
    timestamp: new Date().toISOString(),
    server: {
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      bufferSize: stats.bufferSize,
      isProcessing: stats.isProcessing
    },
    logStore: {
      totalProcessed: stats.totalProcessed,
      totalFailed: stats.totalFailed,
      successRate: stats.successRate,
      pendingLogsCount: pendingLogs.length,
      permanentlyFailedLogsCount: failedLogs.length,
      lastProcessedAt: stats.lastProcessedAt
    },
    issues: issues.length > 0 ? issues : null,
    recommendations: healthStatus !== 'healthy' ? [
      healthStatus === 'critical' ? '데이터베이스 연결 상태를 확인하세요' : null,
      stats.bufferSize > stats.batchSize * 2 ? '수동 플러시를 실행하세요' : null,
      failedLogs.length > 0 ? '실패한 로그들을 재시도하세요' : null
    ].filter(Boolean) : null
  });
});

/**
 * @swagger
 * /api/logs/partitions:
 *   get:
 *     summary: 파티션 목록 조회
 *     description: 로그 스토어의 파티션 목록을 조회합니다.
 *     tags:
 *       - Logs
 *     security:
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: 파티션 목록 조회 성공
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: string
 *       401:
 *         description: 인증 실패
 *       500:
 *         description: 서버 에러
 */
// GET /api/logs/partitions - 파티션 목록 조회
router.get('/partitions', async (req, res) => {
  try {
    const partitionList = await getPartitionList();
    
    res.json({
      success: true,
      data: partitionList,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('파티션 목록 조회 실패:', error);
    res.status(500).json({
      error: '파티션 목록 조회에 실패했습니다',
      message: error.message
    });
  }
});

/**
 * @swagger
 * /api/logs/current-table:
 *   get:
 *     summary: 현재 사용 중인 테이블 정보 조회
 *     description: 로그 스토어의 현재 사용 중인 테이블 정보를 조회합니다.
 *     tags:
 *       - Logs
 *     security:
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: 테이블 정보 조회 성공
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 tableName:
 *                   type: string
 *                   description: 현재 사용 중인 테이블 이름
 *       401:
 *         description: 인증 실패
 *       500:
 *         description: 서버 에러
 */
// GET /api/logs/current-table - 현재 사용 중인 테이블 정보 조회
router.get('/current-table', async (req, res) => {
  try {
    const tableName = await getCurrentTableName();
    
    res.json({
      success: true,
      data: {
        tableName: tableName
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('테이블 정보 조회 실패:', error);
    res.status(500).json({
      error: '테이블 정보 조회에 실패했습니다',
      message: error.message
    });
  }
});

/**
 * @swagger
 * /api/logs/switch-to-partitioned:
 *   post:
 *     summary: 파티션 테이블로 전환
 *     description: 로그 스토어를 파티션 테이블로 전환합니다.
 *     tags:
 *       - Logs
 *     security:
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: 전환 성공
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SuccessResponse'
 *       401:
 *         description: 인증 실패
 *       500:
 *         description: 서버 에러
 */
// POST /api/logs/switch-to-partitioned - 파티션 테이블로 전환
router.post('/switch-to-partitioned', async (req, res) => {
  try {
    await switchToPartitionedTable();
    
    res.json({
      success: true,
      message: '로그 스토어가 파티션 테이블로 전환되었습니다',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('파티션 테이블로 전환 실패:', error);
    res.status(500).json({
      error: '로그 스토어를 파티션 테이블로 전환에 실패했습니다',
      message: error.message
    });
  }
});

/**
 * @swagger
 * /api/logs/switch-to-legacy:
 *   post:
 *     summary: 레그시 테이블로 전환
 *     description: 로그 스토어를 레그시 테이블로 전환합니다.
 *     tags:
 *       - Logs
 *     security:
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: 전환 성공
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SuccessResponse'
 *       401:
 *         description: 인증 실패
 *       500:
 *         description: 서버 에러
 */
// POST /api/logs/switch-to-legacy - 레그시 테이블로 전환
router.post('/switch-to-legacy', async (req, res) => {
  try {
    await switchToLegacyTable();
    
    res.json({
      success: true,
      message: '로그 스토어가 레그시 테이블로 전환되었습니다',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('레그시 테이블로 전환 실패:', error);
    res.status(500).json({
      error: '로그 스토어를 레그시 테이블로 전환에 실패했습니다',
      message: error.message
    });
  }
});

/**
 * @swagger
 * /api/logs/retry-failed:
 *   post:
 *     summary: 실패한 로그 재시도
 *     description: 영구 실패한 로그들을 다시 처리 대기열에 추가합니다.
 *     tags:
 *       - Management
 *     security:
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: 재시도 성공
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/SuccessResponse'
 *                 - type: object
 *                   properties:
 *                     retriedCount:
 *                       type: integer
 *                       description: 재시도한 로그 개수
 *       401:
 *         description: 인증 실패
 *       500:
 *         description: 서버 에러
 */
// POST /api/logs/retry-failed - 실패한 로그 재시도
router.post('/retry-failed', async (req, res) => {
  try {
    const failedLogs = logMemoryStore.getFailedLogs();
    const failedCount = failedLogs.length;
    
    if (failedCount === 0) {
      return res.json({
        success: true,
        message: '재시도할 실패한 로그가 없습니다',
        retriedCount: 0,
        timestamp: new Date().toISOString()
      });
    }
    
    await logMemoryStore.retryFailedLogs();
    
    res.json({
      success: true,
      message: `${failedCount}개 실패한 로그 재시도를 시작했습니다`,
      retriedCount: failedCount,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('실패한 로그 재시도 중 에러:', error);
    res.status(500).json({
      error: '실패한 로그 재시도에 실패했습니다',
      message: error.message
    });
  }
});

/**
 * @swagger
 * /api/logs/failed:
 *   get:
 *     summary: 실패한 로그 목록 조회
 *     description: 영구 실패한 로그들의 상세 정보를 조회합니다.
 *     tags:
 *       - Monitoring
 *     security:
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: 실패한 로그 목록 조회 성공
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       logId:
 *                         type: string
 *                       type:
 *                         type: string
 *                       message:
 *                         type: string
 *                       retryCount:
 *                         type: integer
 *                       finalFailureReason:
 *                         type: string
 *                       finalFailureAt:
 *                         type: number
 *       401:
 *         description: 인증 실패
 *       500:
 *         description: 서버 에러
 */
// GET /api/logs/failed - 실패한 로그 목록 조회
router.get('/failed', async (req, res) => {
  try {
    const failedLogs = logMemoryStore.getFailedLogs();
    
    res.json({
      success: true,
      data: failedLogs.map(log => ({
        logId: log.logId,
        type: log.type,
        message: log.message?.slice(0, 100) + (log.message?.length > 100 ? '...' : ''),
        level: log.level,
        retryCount: log.retryCount,
        finalFailureReason: log.finalFailureReason,
        finalFailureAt: log.finalFailureAt,
        createdAt: log.createdAt,
        batchId: log.batchId
      })),
      count: failedLogs.length,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('실패한 로그 목록 조회 실패:', error);
    res.status(500).json({
      error: '실패한 로그 목록 조회에 실패했습니다',
      message: error.message
    });
  }
});

/**
 * @swagger
 * /api/logs/pending:
 *   get:
 *     summary: 처리 중인 로그 목록 조회
 *     description: 현재 처리 중인 로그들의 상세 정보를 조회합니다.
 *     tags:
 *       - Monitoring
 *     security:
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: 처리 중인 로그 목록 조회 성공
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: array
 *                   items:
 *                     type: object
 *       401:
 *         description: 인증 실패
 *       500:
 *         description: 서버 에러
 */
// GET /api/logs/pending - 처리 중인 로그 목록 조회
router.get('/pending', async (req, res) => {
  try {
    const pendingLogs = logMemoryStore.getPendingLogs();
    
    res.json({
      success: true,
      data: pendingLogs.map(log => ({
        logId: log.logId,
        type: log.type,
        message: log.message?.slice(0, 100) + (log.message?.length > 100 ? '...' : ''),
        level: log.level,
        retryCount: log.retryCount,
        batchId: log.batchId,
        processingStartedAt: log.processingStartedAt,
        processingDuration: Date.now() - log.processingStartedAt,
        createdAt: log.createdAt
      })),
      count: pendingLogs.length,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('처리 중인 로그 목록 조회 실패:', error);
    res.status(500).json({
      error: '처리 중인 로그 목록 조회에 실패했습니다',
      message: error.message
    });
  }
});

export default router; 