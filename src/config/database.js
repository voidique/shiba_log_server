import postgres from 'postgres';
import dotenv from 'dotenv';

dotenv.config();

const sql = postgres(process.env.SHIBA_LOG_DATABASE_URL || '', {
  max: 20,
  idle_timeout: 30,
  connect_timeout: 10,
  types: {
    jsonb: {
      to: 1114,
      from: [3802],
      serialize: JSON.stringify,
      parse: JSON.parse,
    },
  },
});

// 설정: 사용할 테이블 선택
const USE_PARTITIONED_TABLE = true; // true: 파티션 테이블 사용, false: 기존 테이블 사용
const PARTITIONED_TABLE_NAME = 'game_logs_partitioned'; // 새로운 파티션 테이블명
const LEGACY_TABLE_NAME = 'game_logs'; // 기존 테이블명

// 현재 사용 중인 테이블명 반환
export const getCurrentTableName = () => {
  return USE_PARTITIONED_TABLE ? PARTITIONED_TABLE_NAME : LEGACY_TABLE_NAME;
};

// 파티션 테이블 생성 및 초기 설정
export const createPartitionTable = async () => {
  try {
    if (!USE_PARTITIONED_TABLE) {
      console.log('ℹ️  파티션 테이블 사용 안함 - 기존 테이블 사용');
      console.log(`📋 현재 사용 테이블: ${LEGACY_TABLE_NAME}`);
      
      // 기존 테이블에 인덱스만 추가
      await sql.unsafe(`
        CREATE INDEX IF NOT EXISTS idx_game_logs_timestamp ON ${LEGACY_TABLE_NAME}(timestamp)
      `);
      await sql.unsafe(`
        CREATE INDEX IF NOT EXISTS idx_game_logs_type ON ${LEGACY_TABLE_NAME}(type)
      `);
      await sql.unsafe(`
        CREATE INDEX IF NOT EXISTS idx_game_logs_level ON ${LEGACY_TABLE_NAME}(level)
      `);
      
      console.log('✅ 기존 테이블 인덱스 설정 완료');
      return;
    }

    console.log('🚀 새로운 파티션 테이블 시스템 구축 중...');
    console.log(`📋 파티션 테이블명: ${PARTITIONED_TABLE_NAME}`);
    console.log(`🔒 기존 테이블(${LEGACY_TABLE_NAME})은 건드리지 않습니다`);

    // 파티션 테이블이 이미 존재하는지 확인
    const existingPartitionTable = await sql`
      SELECT tablename
      FROM pg_tables 
      WHERE tablename = ${PARTITIONED_TABLE_NAME}
      AND schemaname = 'public'
    `;

    if (existingPartitionTable.length > 0) {
      console.log('📋 파티션 테이블이 이미 존재합니다');
    } else {
      // 새로운 파티션 테이블 생성
      console.log('🆕 새로운 파티션 테이블을 생성합니다');
      await sql.unsafe(`
        CREATE TABLE ${PARTITIONED_TABLE_NAME} (
          id BIGSERIAL,
          timestamp TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
          level VARCHAR(10) NOT NULL,
          type VARCHAR(50) NOT NULL,
          message TEXT NOT NULL,
          metadata JSONB,
          PRIMARY KEY (timestamp, id)
        ) PARTITION BY RANGE (timestamp)
      `);
      console.log('✅ 파티션 테이블 생성 완료');
    }

    // 파티션 테이블 인덱스 생성
    await sql.unsafe(`
      CREATE INDEX IF NOT EXISTS idx_${PARTITIONED_TABLE_NAME}_timestamp ON ${PARTITIONED_TABLE_NAME}(timestamp)
    `);
    await sql.unsafe(`
      CREATE INDEX IF NOT EXISTS idx_${PARTITIONED_TABLE_NAME}_type ON ${PARTITIONED_TABLE_NAME}(type)
    `);
    await sql.unsafe(`
      CREATE INDEX IF NOT EXISTS idx_${PARTITIONED_TABLE_NAME}_level ON ${PARTITIONED_TABLE_NAME}(level)
    `);

    console.log('✅ 파티션 테이블 및 인덱스 설정 완료');
    console.log('📅 월별 파티션 생성을 시작합니다...');
    await createInitialPartitions();

  } catch (error) {
    console.error('❌ 파티션 테이블 생성 실패:', error);
    throw error;
  }
};

// 초기 파티션들을 생성 (2025년 6월부터)
const createInitialPartitions = async () => {
  if (!USE_PARTITIONED_TABLE) return;

  const now = new Date();
  const startYear = 2025;
  const startMonth = 6; // 6월
  
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth() + 1;

  console.log(`📅 ${startYear}년 ${startMonth}월부터 ${currentYear}년 ${currentMonth}월까지 파티션 생성 중...`);

  for (let year = startYear; year <= currentYear; year++) {
    const monthStart = (year === startYear) ? startMonth : 1;
    const monthEnd = (year === currentYear) ? currentMonth : 12;
    
    for (let month = monthStart; month <= monthEnd; month++) {
      await createMonthlyPartition(new Date(year, month - 1, 1));
    }
  }

  // 다음 달 파티션도 미리 생성
  const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  await createMonthlyPartition(nextMonth);
};

// 월별 파티션 생성
export const createMonthlyPartition = async (date) => {
  if (!USE_PARTITIONED_TABLE) return;

  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  const partitionName = `${PARTITIONED_TABLE_NAME}_${year}_${month
    .toString()
    .padStart(2, '0')}`;
  const startDate = new Date(year, month - 1, 1);
  const endDate = new Date(year, month, 1);

  try {
    // 파티션이 이미 존재하는지 확인
    const existingPartition = await sql`
      SELECT tablename 
      FROM pg_tables 
      WHERE tablename = ${partitionName}
    `;

    if (existingPartition.length > 0) {
      console.log(`⏭️  파티션 이미 존재: ${partitionName}`);
      return;
    }

    await sql.unsafe(`
      CREATE TABLE ${partitionName}
      PARTITION OF ${PARTITIONED_TABLE_NAME}
      FOR VALUES FROM ('${startDate.toISOString()}') TO ('${endDate.toISOString()}')
    `);
    
    console.log(`✅ 새 파티션 생성: ${partitionName} (${startDate.toISOString().split('T')[0]} ~ ${endDate.toISOString().split('T')[0]})`);
  } catch (error) {
    console.error(`❌ 파티션 테이블 생성 실패 (${partitionName}):`, error);
  }
};

// 매월 자동으로 새 파티션 생성 (서버 실행 중)
export const ensureCurrentMonthPartition = async () => {
  if (!USE_PARTITIONED_TABLE) return;

  const now = new Date();
  await createMonthlyPartition(now);
  
  // 다음 달 파티션도 미리 생성
  const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  await createMonthlyPartition(nextMonth);
};

// 파티션 목록 조회
export const getPartitionList = async () => {
  try {
    const currentTable = getCurrentTableName();
    const partitions = await sql`
      SELECT 
        schemaname,
        tablename,
        CASE 
          WHEN tablename = ${currentTable} THEN '메인 테이블'
          WHEN tablename ~ ${`^${currentTable.replace('_', '\\_')}_[0-9]{4}_[0-9]{2}$`} THEN
            CONCAT(
              SUBSTRING(tablename FROM ${currentTable.length + 2} FOR 4), '년 ',
              LPAD(SUBSTRING(tablename FROM ${currentTable.length + 7} FOR 2), 2, '0'), '월'
            )
          ELSE '기타'
        END as period,
        CASE WHEN tablename = ${currentTable} THEN 1 ELSE 2 END as sort_order
      FROM pg_tables 
      WHERE tablename LIKE ${currentTable + '%'}
      ORDER BY sort_order, tablename
    `;
    
    return partitions;
  } catch (error) {
    console.error('❌ 파티션 목록 조회 실패:', error);
    return [];
  }
};

// 배치 삽입 함수 (트랜잭션 기반으로 완전 개선)
export const batchInsert = async (logs) => {
  if (!logs || logs.length === 0) {
    return [];
  }

  let transaction = null;
  try {
    const currentTable = getCurrentTableName();
    
    // 파티션 테이블 사용 시에만 파티션 확인/생성
    if (USE_PARTITIONED_TABLE) {
      await ensureCurrentMonthPartition();
    }
    
    // 트랜잭션 시작
    transaction = await sql.begin();
    console.log(`🔄 트랜잭션 시작 - ${logs.length}개 로그 일괄 처리`);
    
    // 벌크 삽입을 위한 데이터 준비
    const values = logs.map(log => [
      log.level || 'info',
      log.type,
      log.message,
      log.metadata || null
    ]);
    
    // 벌크 삽입 실행 (트랜잭션 내에서)
    const result = await transaction.unsafe(`
      INSERT INTO ${currentTable} (level, type, message, metadata)
      SELECT * FROM UNNEST(
        $1::VARCHAR[],
        $2::VARCHAR[],
        $3::TEXT[],
        $4::JSONB[]
      )
    `, [
      values.map(v => v[0]),  // levels
      values.map(v => v[1]),  // types
      values.map(v => v[2]),  // messages
      values.map(v => v[3])   // metadata
    ]);
    
    // 트랜잭션 커밋
    await transaction.commit();
    console.log(`✅ 트랜잭션 커밋 완료 - ${logs.length}개 로그 저장 성공`);
    
    return result;
    
  } catch (error) {
    // 트랜잭션 롤백
    if (transaction) {
      try {
        await transaction.rollback();
        console.log(`🔄 트랜잭션 롤백 완료 - ${logs.length}개 로그 저장 실패`);
      } catch (rollbackError) {
        console.error('❌ 트랜잭션 롤백 실패:', rollbackError);
      }
    }
    
    // 에러 세부 정보 로깅
    console.error('❌ 배치 삽입 실패 상세:', {
      errorMessage: error.message,
      errorCode: error.code,
      logsCount: logs.length,
      tableName: getCurrentTableName(),
      timestamp: new Date().toISOString()
    });
    
    throw error;
  }
};

// 로그 조회 함수
export const queryLogs = async (filters = {}) => {
  const {
    type,
    level,
    message,
    startDate,
    endDate,
    limit = 50,
    offset = 0
  } = filters;

  try {
    const currentTable = getCurrentTableName();
    let conditions = [];
    let params = [];

    if (type) {
      conditions.push('type = $' + (params.length + 1));
      params.push(type);
    }
    if (level) {
      conditions.push('level = $' + (params.length + 1));
      params.push(level);
    }
    if (message) {
      conditions.push('message ILIKE $' + (params.length + 1));
      params.push(`%${message}%`);
    }
    if (startDate) {
      conditions.push('timestamp >= $' + (params.length + 1));
      params.push(startDate);
    }
    if (endDate) {
      conditions.push('timestamp <= $' + (params.length + 1));
      params.push(endDate);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    
    const query = `
      WITH filtered_logs AS (
        SELECT * FROM ${currentTable} ${whereClause}
      )
      SELECT 
        (SELECT COUNT(*) FROM filtered_logs) as total_count,
        fl.*
      FROM filtered_logs fl
      ORDER BY timestamp DESC
      LIMIT $${params.length + 1}
      OFFSET $${params.length + 2}
    `;

    params.push(limit, offset);
    
    const result = await sql.unsafe(query, params);
    return result;
  } catch (error) {
    console.error('❌ 로그 조회 실패:', error);
    throw error;
  }
};

// 데이터 정리 함수 (사용자가 원하지 않으므로 비활성화)
export const cleanupOldData = async (monthsToKeep = 6) => {
  console.log(`ℹ️  데이터 정리 기능이 호출되었지만 실행하지 않습니다 (데이터 보호)`);
  console.log(`📋 ${monthsToKeep}개월 이전 데이터 정리가 요청되었으나 건너뜀`);
  return;
};

// 연결 상태 모니터링 개선
export const testConnection = async () => {
  try {
    const startTime = Date.now();
    await sql`SELECT 1 as health_check, NOW() as server_time`;
    const endTime = Date.now();
    const responseTime = endTime - startTime;
    
    console.log(`✅ 데이터베이스 연결 성공 (응답시간: ${responseTime}ms)`);
    
    // 응답 시간이 5초 이상이면 경고
    if (responseTime > 5000) {
      console.warn(`⚠️  데이터베이스 응답이 느립니다 (${responseTime}ms)`);
    }
    
    return true;
  } catch (error) {
    console.error('❌ 데이터베이스 연결 실패 상세:', {
      errorMessage: error.message,
      errorCode: error.code,
      timestamp: new Date().toISOString()
    });
    return false;
  }
};

// 데이터베이스 연결 상태 주기적 모니터링
let healthCheckInterval = null;

export const startConnectionMonitoring = () => {
  if (healthCheckInterval) {
    clearInterval(healthCheckInterval);
  }
  
  // 5분마다 연결 상태 확인
  healthCheckInterval = setInterval(async () => {
    try {
      const isHealthy = await testConnection();
      if (!isHealthy) {
        console.error('❌ 데이터베이스 연결 상태 불량 - 로그 저장에 문제가 발생할 수 있습니다');
      }
    } catch (error) {
      console.error('❌ 연결 상태 모니터링 중 에러:', error);
    }
  }, 5 * 60 * 1000); // 5분
  
  console.log('🔍 데이터베이스 연결 상태 모니터링 시작 (5분 간격)');
};

export const stopConnectionMonitoring = () => {
  if (healthCheckInterval) {
    clearInterval(healthCheckInterval);
    healthCheckInterval = null;
    console.log('🔍 데이터베이스 연결 상태 모니터링 종료');
  }
};

// 파티션 관리를 위한 스케줄러 (매일 자정에 실행)
export const startPartitionScheduler = async () => {
  try {
    if (!USE_PARTITIONED_TABLE) {
      console.log('ℹ️  파티션 테이블을 사용하지 않으므로 스케줄러를 시작하지 않습니다');
      return;
    }
    
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(0, 0, 0, 0);
    
    const timeUntilMidnight = tomorrow.getTime() - now.getTime();
    
    setTimeout(() => {
      // 매일 자정에 파티션 확인
      setInterval(async () => {
        console.log('🕛 일일 파티션 확인 중...');
        await ensureCurrentMonthPartition();
      }, 24 * 60 * 60 * 1000); // 24시간마다
      
      // 첫 실행
      ensureCurrentMonthPartition();
    }, timeUntilMidnight);
    
    console.log(`⏰ 파티션 스케줄러 시작됨 (다음 실행: ${tomorrow.toLocaleString('ko-KR')})`);
  } catch (error) {
    console.error('❌ 파티션 스케줄러 시작 실패:', error);
  }
};

// 테이블 전환 함수 (운영 중 전환 가능)
export const switchToPartitionedTable = async () => {
  console.log('🔄 파티션 테이블로 전환 중...');
  console.log('ℹ️  이 작업은 서버 재시작 후 적용됩니다');
  console.log('📝 database.js 파일에서 USE_PARTITIONED_TABLE = true로 설정하세요');
};

export const switchToLegacyTable = async () => {
  console.log('🔄 기존 테이블로 전환 중...');
  console.log('ℹ️  이 작업은 서버 재시작 후 적용됩니다');
  console.log('📝 database.js 파일에서 USE_PARTITIONED_TABLE = false로 설정하세요');
};

export default sql; 