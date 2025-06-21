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

// 파티션 테이블 생성 및 초기 설정
export const createPartitionTable = async () => {
  try {
    // 기존 테이블이 파티션 테이블인지 확인
    const existingTable = await sql`
      SELECT 
        schemaname, 
        tablename, 
        partitionname IS NOT NULL as is_partitioned
      FROM pg_tables 
      LEFT JOIN pg_partitions ON pg_tables.tablename = pg_partitions.tablename
      WHERE pg_tables.tablename = 'game_logs'
    `;

    if (existingTable.length > 0 && !existingTable[0].is_partitioned) {
      console.log('📋 기존 game_logs 테이블이 발견되었습니다 (파티션 테이블 아님)');
      console.log('✅ 기존 데이터는 그대로 유지됩니다');
    } else {
      // 메인 파티션 테이블 생성 (기존 테이블이 없거나 이미 파티션 테이블인 경우)
      await sql`
        CREATE TABLE IF NOT EXISTS game_logs (
          id BIGSERIAL,
          timestamp TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
          level VARCHAR(10) NOT NULL,
          type VARCHAR(50) NOT NULL,
          message TEXT NOT NULL,
          metadata JSONB,
          PRIMARY KEY (timestamp, id)
        ) PARTITION BY RANGE (timestamp)
      `;
    }

    // 인덱스 생성 (기존 테이블에도 적용)
    await sql`
      CREATE INDEX IF NOT EXISTS idx_game_logs_timestamp ON game_logs(timestamp)
    `;
    await sql`
      CREATE INDEX IF NOT EXISTS idx_game_logs_type ON game_logs(type)
    `;
    await sql`
      CREATE INDEX IF NOT EXISTS idx_game_logs_level ON game_logs(level)
    `;

    console.log('✅ 파티션 테이블 및 인덱스 설정 완료');

    // 2025년 6월부터 현재 월까지의 파티션 자동 생성
    await createInitialPartitions();

  } catch (error) {
    console.error('❌ 파티션 테이블 생성 실패:', error);
    throw error;
  }
};

// 초기 파티션들을 생성 (2025년 6월부터)
const createInitialPartitions = async () => {
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
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  const partitionName = `game_logs_${year}_${month
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

    await sql`
      CREATE TABLE ${sql(partitionName)}
      PARTITION OF game_logs
      FOR VALUES FROM (${startDate.toISOString()}) TO (${endDate.toISOString()})
    `;
    
    console.log(`✅ 새 파티션 생성: ${partitionName} (${startDate.toISOString().split('T')[0]} ~ ${endDate.toISOString().split('T')[0]})`);
  } catch (error) {
    console.error(`❌ 파티션 테이블 생성 실패 (${partitionName}):`, error);
  }
};

// 매월 자동으로 새 파티션 생성 (서버 실행 중)
export const ensureCurrentMonthPartition = async () => {
  const now = new Date();
  await createMonthlyPartition(now);
  
  // 다음 달 파티션도 미리 생성
  const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  await createMonthlyPartition(nextMonth);
};

// 파티션 목록 조회
export const getPartitionList = async () => {
  try {
    const partitions = await sql`
      SELECT 
        schemaname,
        tablename,
        CASE 
          WHEN tablename ~ '^game_logs_[0-9]{4}_[0-9]{2}$' THEN
            CONCAT(
              SUBSTRING(tablename FROM 11 FOR 4), '년 ',
              LPAD(SUBSTRING(tablename FROM 16 FOR 2), 2, '0'), '월'
            )
          ELSE '기본 테이블'
        END as period
      FROM pg_tables 
      WHERE tablename LIKE 'game_logs%'
      ORDER BY tablename
    `;
    
    return partitions;
  } catch (error) {
    console.error('❌ 파티션 목록 조회 실패:', error);
    return [];
  }
};

// 배치 삽입 함수
export const batchInsert = async (logs) => {
  try {
    // 현재 월 파티션이 존재하는지 확인하고 없으면 생성
    await ensureCurrentMonthPartition();
    
    const result = await sql`
      INSERT INTO game_logs ${sql(logs, 'level', 'type', 'message', 'metadata')}
    `;
    return result;
  } catch (error) {
    console.error('❌ 배치 삽입 실패:', error);
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
        SELECT * FROM game_logs ${whereClause}
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

// 연결 테스트
export const testConnection = async () => {
  try {
    await sql`SELECT 1`;
    console.log('✅ 데이터베이스 연결 성공');
    return true;
  } catch (error) {
    console.error('❌ 데이터베이스 연결 실패:', error);
    return false;
  }
};

// 파티션 관리를 위한 스케줄러 (매일 자정에 실행)
export const startPartitionScheduler = () => {
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
};

export default sql; 