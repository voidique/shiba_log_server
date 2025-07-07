import { batchInsert, createMonthlyPartition } from '../config/database.js';
import { randomUUID } from 'crypto';

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

  startFlushTimer() {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
    }
    
    this.flushTimer = setInterval(async () => {
      try {
        await this.processBuffer();
      } catch (error) {
        console.error('⚠️ 타이머 기반 버퍼 처리 중 에러:', error);
      }
    }, this.FLUSH_INTERVAL);
    
    console.log(`⏰ 플러시 타이머 시작 (간격: ${this.FLUSH_INTERVAL}ms, 배치 크기: ${this.BATCH_SIZE})`);
  }

  async addLog(log) {
    // 고유 ID와 타임스탬프 추가
    const logWithId = {
      ...log,
      logId: randomUUID(),           // 고유 ID 추가
      timestamp: new Date(),         // 타임스탬프
      retryCount: 0,                 // 재시도 횟수
      createdAt: Date.now(),         // 생성 시간 (밀리초)
    };

    this.buffer.push(logWithId);
    console.log(`📝 로그 추가됨 [ID: ${logWithId.logId.slice(0, 8)}...] (버퍼 크기: ${this.buffer.length}/${this.BATCH_SIZE})`);

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
    if (filters.startDate) {
      filteredLogs = filteredLogs.filter(
        log => new Date(log.timestamp) >= new Date(filters.startDate)
      );
    }
    if (filters.endDate) {
      filteredLogs = filteredLogs.filter(
        log => new Date(log.timestamp) <= new Date(filters.endDate)
      );
    }

    // 페이지네이션 처리
    const total = filteredLogs.length;
    const page = filters.page || 1;
    const limit = filters.limit || 50;
    const offset = (page - 1) * limit;

    return {
      records: filteredLogs
        .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
        .slice(offset, offset + limit),
      total,
      page,
      totalPages: Math.ceil(total / limit),
    };
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