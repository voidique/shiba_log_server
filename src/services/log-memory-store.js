import { batchInsert, createMonthlyPartition } from '../config/database.js';
import { randomUUID } from 'crypto';
import { writeFileSync, appendFileSync, existsSync } from 'fs';
import { join } from 'path';

export class LogMemoryStore {
  static instance = null;
  
  constructor() {
    if (LogMemoryStore.instance) {
      return LogMemoryStore.instance;
    }

    this.buffer = [];
    this._isProcessing = false;
    this.BATCH_SIZE = parseInt(process.env.LOG_BATCH_SIZE) || 1000;
    this.FLUSH_INTERVAL = parseInt(process.env.LOG_FLUSH_INTERVAL_MS) || 60000;
    this.flushTimer = null;
    
    // 새로 추가된 속성들
    this.pendingLogs = new Map(); // 처리 중인 로그들 추적
    this.failedLogs = new Map();  // 실패한 로그들 저장
    this.totalProcessed = 0;      // 총 처리된 로그 수
    this.totalFailed = 0;         // 총 실패한 로그 수
    this.lastProcessedAt = null;  // 마지막 처리 시간
    this.maxRetries = 3;          // 최대 재시도 횟수
    
    // 에러 로그 파일 경로
    this.errorLogPath = join(process.cwd(), 'error.txt');

    this.startFlushTimer();
    LogMemoryStore.instance = this;
    
    console.log('🚀 LogMemoryStore 초기화 완료 (개선된 버전)');
  }

  static getInstance() {
    if (!LogMemoryStore.instance) {
      LogMemoryStore.instance = new LogMemoryStore();
    }
    return LogMemoryStore.instance;
  }

  // 에러 로그를 error.txt 파일에 기록하는 함수
  writeErrorLog(error, context = {}) {
    try {
      const timestamp = new Date().toISOString();
      const errorEntry = {
        timestamp,
        error: {
          message: error.message,
          stack: error.stack,
          name: error.name
        },
        context,
        serverInfo: {
          uptime: process.uptime(),
          memoryUsage: process.memoryUsage(),
          nodeVersion: process.version
        }
      };

      const logLine = `
================================================================================
[${timestamp}] LOG PROCESSING ERROR
================================================================================
Error Message: ${error.message}
Error Type: ${error.name}
Context: ${JSON.stringify(context, null, 2)}

Stack Trace:
${error.stack}

Server Info:
- Uptime: ${process.uptime()}s
- Memory Usage: ${JSON.stringify(process.memoryUsage(), null, 2)}
- Node Version: ${process.version}

================================================================================

`;

      // 파일이 존재하지 않으면 생성, 존재하면 추가
      if (!existsSync(this.errorLogPath)) {
        writeFileSync(this.errorLogPath, `Shiba Log Server - Error Log\nCreated: ${timestamp}\n\n`);
      }
      
      appendFileSync(this.errorLogPath, logLine);
      
      console.log(`📝 에러 로그가 error.txt에 기록되었습니다: ${error.message}`);
      
    } catch (writeError) {
      console.error('❌ error.txt 파일 쓰기 실패:', writeError.message);
    }
  }

  startFlushTimer() {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
    }
    
    this.flushTimer = setInterval(async () => {
      try {
        await this.processBuffer();
      } catch (error) {
        console.error('⚠️ 타이머 기반 버퍼 처리 중 에러:', error);
        
        // 타이머 기반 처리 에러도 error.txt에 기록
        this.writeErrorLog(error, {
          operation: 'timerBasedFlush',
          bufferSize: this.buffer.length,
          flushInterval: this.FLUSH_INTERVAL,
          totalProcessed: this.totalProcessed,
          totalFailed: this.totalFailed
        });
      }
    }, this.FLUSH_INTERVAL);
    
    console.log(`⏰ 플러시 타이머 시작 (간격: ${this.FLUSH_INTERVAL}ms, 배치 크기: ${this.BATCH_SIZE})`);
  }

  async addLog(log) {
    // 고유 ID와 타임스탬프 추가
    const now = new Date();
    const logWithId = {
      ...log,
      logId: randomUUID(),           // 고유 ID 추가
      timestamp: now,                // 기존 timestamp (호환성)
      createdAt: now.getTime(),      // 생성 시간 (밀리초) - DB의 created_at에 사용
      addedToBufferAt: now,          // 버퍼에 추가된 시간
      retryCount: 0,                 // 재시도 횟수
    };

    this.buffer.push(logWithId);
    // console.log(`📝 로그 추가됨 [ID: ${logWithId.logId.slice(0, 8)}...] (생성시간: ${now.toISOString()}) (버퍼 크기: ${this.buffer.length}/${this.BATCH_SIZE})`);

    // 배치 크기에 도달하면 즉시 처리
    if (this.buffer.length >= this.BATCH_SIZE) {
      console.log('🚀 배치 크기 도달 - 즉시 처리 시작');
      await this.processBuffer();
    }
  }

  async processBuffer() {
    if (this._isProcessing || this.buffer.length === 0) {
      return;
    }

    console.log(`🔄 버퍼 처리 시작 (${this.buffer.length}개 로그)`);
    this._isProcessing = true;
    this.lastProcessedAt = new Date();
    
    // 처리할 로그들을 버퍼에서 추출
    const logsToProcess = this.buffer.splice(0, this.BATCH_SIZE);
    const batchId = randomUUID().slice(0, 8);
    
    console.log(`📦 배치 [${batchId}] 처리 시작 - ${logsToProcess.length}개 로그`);
    
    // 처리 중인 로그들을 추적
    logsToProcess.forEach(log => {
      this.pendingLogs.set(log.logId, {
        ...log,
        batchId,
        processingStartedAt: Date.now()
      });
    });
    
    try {
      // 현재 월의 파티션이 존재하는지 확인하고 생성
      await this.ensureCurrentMonthPartition();
      
      // 5초 타임아웃으로 DB 삽입 실행 (기존 10초에서 단축)
      await Promise.race([
        batchInsert(logsToProcess),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('DB insert timeout after 5 seconds')), 5000)
        ),
      ]);

      // 성공: 처리 중인 로그들 제거
      logsToProcess.forEach(log => {
        this.pendingLogs.delete(log.logId);
      });
      
      this.totalProcessed += logsToProcess.length;
      console.log(`✅ 배치 [${batchId}] 처리 완료 - ${logsToProcess.length}개 로그 저장 성공 (총 처리: ${this.totalProcessed})`);
      
    } catch (error) {
      console.error(`❌ 배치 [${batchId}] 처리 실패:`, {
        error: error.message,
        logsCount: logsToProcess.length,
        timestamp: new Date().toISOString()
      });
      
      // 에러 로그를 error.txt 파일에 기록
      this.writeErrorLog(error, {
        batchId,
        logsCount: logsToProcess.length,
        bufferSize: this.buffer.length,
        totalProcessed: this.totalProcessed,
        totalFailed: this.totalFailed,
        operation: 'batchInsert',
        sampleLogs: logsToProcess.slice(0, 3).map(log => ({
          logId: log.logId,
          type: log.type,
          message: log.message?.slice(0, 100),
          retryCount: log.retryCount
        }))
      });
      
      // 실패한 로그들 처리
      const retryableLogs = [];
      const permanentlyFailedLogs = [];
      
      logsToProcess.forEach(log => {
        this.pendingLogs.delete(log.logId);
        
        if (log.retryCount < this.maxRetries) {
          // 재시도 가능한 로그
          log.retryCount++;
          log.lastFailureReason = error.message;
          log.lastFailureAt = Date.now();
          retryableLogs.push(log);
        } else {
          // 최대 재시도 횟수 초과
          this.failedLogs.set(log.logId, {
            ...log,
            finalFailureReason: error.message,
            finalFailureAt: Date.now(),
            batchId
          });
          permanentlyFailedLogs.push(log);
        }
      });
      
      // 재시도 가능한 로그들을 버퍼 뒤쪽에 추가 (FIFO 순서 유지)
      if (retryableLogs.length > 0) {
        this.buffer.push(...retryableLogs);
        console.log(`🔄 ${retryableLogs.length}개 로그 재시도 대기열에 추가됨 (총 버퍼: ${this.buffer.length})`);
      }
      
      if (permanentlyFailedLogs.length > 0) {
        this.totalFailed += permanentlyFailedLogs.length;
        console.error(`💀 ${permanentlyFailedLogs.length}개 로그 영구 실패 (최대 재시도 횟수 초과)`);
      }
      
    } finally {
      this._isProcessing = false;
    }
  }

  async ensureCurrentMonthPartition() {
    try {
      const now = new Date();
      await createMonthlyPartition(now);
    } catch (error) {
      console.error('⚠️ 월별 파티션 생성 중 에러:', error);
      // 파티션 생성 실패는 치명적이므로 에러를 다시 던짐
      throw new Error(`파티션 생성 실패: ${error.message}`);
    }
  }

  async forceFlush() {
    console.log('🔥 강제 플러시 실행');
    
    // 여러 번 플러시하여 모든 로그가 처리될 때까지 시도
    let attempts = 0;
    const maxAttempts = 10;
    
    while (this.buffer.length > 0 && attempts < maxAttempts) {
      console.log(`🔄 강제 플러시 시도 ${attempts + 1}/${maxAttempts} - 남은 로그: ${this.buffer.length}개`);
      await this.processBuffer();
      
      // 처리 중이라면 잠시 대기
      if (this._isProcessing) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      
      attempts++;
    }
    
    if (this.buffer.length > 0) {
      console.warn(`⚠️ 강제 플러시 완료되었지만 ${this.buffer.length}개 로그가 남아있습니다`);
    } else {
      console.log('✅ 강제 플러시 완료 - 모든 로그 처리됨');
    }
  }

  getStoredLogs(filters = {}) {
    let filteredLogs = [...this.buffer];

    // 필터 적용
    if (filters.type) {
      filteredLogs = filteredLogs.filter(log => log.type === filters.type);
    }
    if (filters.level) {
      filteredLogs = filteredLogs.filter(log => log.level === filters.level);
    }
    if (filters.message) {
      filteredLogs = filteredLogs.filter(log => 
        log.message && log.message.toLowerCase().includes(filters.message.toLowerCase())
      );
    }
    if (filters.startDate) {
      filteredLogs = filteredLogs.filter(
        log => new Date(log.createdAt) >= new Date(filters.startDate)
      );
    }
    if (filters.endDate) {
      filteredLogs = filteredLogs.filter(
        log => new Date(log.createdAt) <= new Date(filters.endDate)
      );
    }
    
    // 새로운 필터들 추가
    if (filters.userId) {
      filteredLogs = filteredLogs.filter(log => 
        log.metadata && 
        log.metadata.user_id && 
        String(log.metadata.user_id) === String(filters.userId)
      );
    }
    
    if (filters.metadata) {
      filteredLogs = filteredLogs.filter(log => {
        if (!log.metadata) return false;
        
        // metadata를 JSON 문자열로 변환하여 검색
        const metadataStr = JSON.stringify(log.metadata).toLowerCase();
        return metadataStr.includes(filters.metadata.toLowerCase());
      });
    }

    // 페이지네이션 처리
    const total = filteredLogs.length;
    const page = filters.page || 1;
    const limit = filters.limit || 50;
    const offset = (page - 1) * limit;

    // created_at 기준으로 정렬하고, 메모리 로그 표시 추가
    const sortedLogs = filteredLogs
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(offset, offset + limit)
      .map(log => ({
        ...log,
        created_at: new Date(log.createdAt).toISOString(),
        logged_at: null, // 아직 DB에 저장되지 않음
        source: 'memory' // 메모리에서 온 로그임을 표시
      }));

    return {
      records: sortedLogs,
      total,
      page,
      totalPages: Math.ceil(total / limit),
    };
  }

  // DB 결과와 메모리 결과를 시간순으로 통합 정렬하는 새로운 메서드
  mergeAndSortLogs(memoryLogs = [], dbLogs = [], limit = 50) {
    try {
      const allLogs = [];
      
      // 메모리 로그 추가 (created_at 기준)
      if (Array.isArray(memoryLogs)) {
        memoryLogs.forEach(log => {
          try {
            allLogs.push({
              ...log,
              created_at: log.createdAt ? new Date(log.createdAt).toISOString() : new Date().toISOString(),
              logged_at: null,
              source: 'memory'
            });
          } catch (error) {
            console.warn('⚠️ 메모리 로그 처리 중 에러:', error.message, 'logId:', log.logId);
          }
        });
      }
      
      // DB 로그 추가
      if (Array.isArray(dbLogs)) {
        dbLogs.forEach(log => {
          try {
            allLogs.push({
              ...log,
              source: 'database'
            });
          } catch (error) {
            console.warn('⚠️ DB 로그 처리 중 에러:', error.message, 'logId:', log.id);
          }
        });
      }
      
      // created_at 기준으로 최신순 정렬
      const sortedLogs = allLogs.sort((a, b) => {
        try {
          const timeA = new Date(a.created_at || a.timestamp);
          const timeB = new Date(b.created_at || b.timestamp);
          
          // 유효하지 않은 날짜 처리
          if (isNaN(timeA.getTime()) || isNaN(timeB.getTime())) {
            console.warn('⚠️ 유효하지 않은 날짜 발견:', { 
              aTime: a.created_at || a.timestamp, 
              bTime: b.created_at || b.timestamp 
            });
            return 0;
          }
          
          return timeB - timeA;
        } catch (error) {
          console.warn('⚠️ 로그 정렬 중 에러:', error.message);
          return 0;
        }
      });
      
      // 제한된 개수만 반환
      const result = sortedLogs.slice(0, Math.max(1, Math.min(limit, 1000)));
      
      console.log(`📊 통합 정렬 완료: 메모리 ${memoryLogs.length}개 + DB ${dbLogs.length}개 → ${result.length}개 반환`);
      return result;
      
    } catch (error) {
      console.error('❌ 로그 통합 정렬 중 에러:', error);
      return []; // 에러 시 빈 배열 반환
    }
  }

  getBufferSize() {
    return this.buffer.length;
  }

  isProcessing() {
    return this._isProcessing;
  }

  async clearBuffer() {
    console.log('🧹 버퍼 클리어');
    this.buffer = [];
    this.pendingLogs.clear();
    
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }

  // 개선된 통계 정보
  getStats() {
    return {
      bufferSize: this.buffer.length,
      batchSize: this.BATCH_SIZE,
      flushInterval: this.FLUSH_INTERVAL,
      isProcessing: this._isProcessing,
      lastProcessedAt: this.lastProcessedAt,
      
      // 새로 추가된 통계
      totalProcessed: this.totalProcessed,
      totalFailed: this.totalFailed,
      pendingLogsCount: this.pendingLogs.size,
      permanentlyFailedLogsCount: this.failedLogs.size,
      maxRetries: this.maxRetries,
      
      // 성능 지표
      successRate: this.totalProcessed + this.totalFailed > 0 
        ? ((this.totalProcessed / (this.totalProcessed + this.totalFailed)) * 100).toFixed(2) + '%'
        : '100%'
    };
  }
  
  // 실패한 로그들 조회
  getFailedLogs() {
    return Array.from(this.failedLogs.values());
  }
  
  // 처리 중인 로그들 조회
  getPendingLogs() {
    return Array.from(this.pendingLogs.values());
  }
  
  // 실패한 로그 재시도
  async retryFailedLogs() {
    const failedLogs = Array.from(this.failedLogs.values());
    if (failedLogs.length === 0) {
      console.log('📝 재시도할 실패한 로그가 없습니다');
      return;
    }
    
    console.log(`🔄 ${failedLogs.length}개 실패한 로그 재시도 시작`);
    
    // 실패한 로그들의 재시도 횟수 초기화하고 버퍼에 추가
    failedLogs.forEach(log => {
      log.retryCount = 0;
      delete log.finalFailureReason;
      delete log.finalFailureAt;
      this.buffer.push(log);
      this.failedLogs.delete(log.logId);
    });
    
    await this.processBuffer();
  }
}

export const logMemoryStore = LogMemoryStore.getInstance(); 