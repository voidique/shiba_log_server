import { batchInsert, createMonthlyPartition } from '../config/database.js';

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

    this.startFlushTimer();
    LogMemoryStore.instance = this;
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
    
    console.log(`⏰ 플러시 타이머 시작 (간격: ${this.FLUSH_INTERVAL}ms)`);
  }

  async addLog(log) {
    // timestamp 추가
    const logWithTimestamp = {
      ...log,
      timestamp: new Date(),
    };

    this.buffer.push(logWithTimestamp);
    console.log(`📝 로그 추가됨 (버퍼 크기: ${this.buffer.length}/${this.BATCH_SIZE})`);

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
    
    // 처리할 로그들을 버퍼에서 추출
    const logsToProcess = this.buffer.splice(0, this.BATCH_SIZE);
    
    try {
      // 현재 월의 파티션이 존재하는지 확인하고 생성
      await this.ensureCurrentMonthPartition();
      
      // 10초 타임아웃으로 DB 삽입 실행
      await Promise.race([
        batchInsert(logsToProcess),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('DB insert timeout')), 10000)
        ),
      ]);

      console.log(`✅ ${logsToProcess.length}개 로그 DB 저장 완료`);
      
    } catch (error) {
      console.error('❌ 버퍼 처리 실패 - 재시도 대기:', error.message);
      
      // 실패한 로그들을 다시 버퍼 맨 앞으로 돌려놓아 다음 주기에 재시도
      this.buffer.unshift(...logsToProcess);
      console.log(`🔄 ${logsToProcess.length}개 로그 재삽입됨 (총 버퍼: ${this.buffer.length})`);
      
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
    }
  }

  async forceFlush() {
    console.log('🔥 강제 플러시 실행');
    await this.processBuffer();
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
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }

  getStats() {
    return {
      bufferSize: this.buffer.length,
      batchSize: this.BATCH_SIZE,
      flushInterval: this.FLUSH_INTERVAL,
      isProcessing: this._isProcessing,
      lastProcessedAt: this.lastProcessedAt || null,
    };
  }
}

export const logMemoryStore = LogMemoryStore.getInstance(); 