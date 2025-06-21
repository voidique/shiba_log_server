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

// 파티션 테이블 생성
export const createPartitionTable = async () => {
  try {
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

    await sql`
      CREATE INDEX IF NOT EXISTS idx_game_logs_timestamp ON game_logs(timestamp)
    `;
    await sql`
      CREATE INDEX IF NOT EXISTS idx_game_logs_type ON game_logs(type)
    `;
    await sql`
      CREATE INDEX IF NOT EXISTS idx_game_logs_level ON game_logs(level)
    `;

    console.log('✅ 파티션 테이블 및 인덱스 생성 완료');
  } catch (error) {
    console.error('❌ 파티션 테이블 생성 실패:', error);
    throw error;
  }
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
    await sql`
      CREATE TABLE IF NOT EXISTS ${sql(partitionName)}
      PARTITION OF game_logs
      FOR VALUES FROM (${startDate}) TO (${endDate})
    `;
    console.log(`✅ 파티션 테이블 생성: ${partitionName}`);
  } catch (error) {
    console.error(`❌ 파티션 테이블 생성 실패 (${partitionName}):`, error);
  }
};

// 배치 삽입 함수
export const batchInsert = async (logs) => {
  try {
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

// 데이터 정리 함수
export const cleanupOldData = async (monthsToKeep = 6) => {
  const date = new Date();
  date.setMonth(date.getMonth() - monthsToKeep);

  try {
    const partitions = await sql`
      SELECT tablename 
      FROM pg_tables 
      WHERE tablename LIKE 'game_logs_%'
    `;

    for (const { tablename } of partitions) {
      const match = tablename.match(/game_logs_(\d{4})_(\d{2})/);
      if (match) {
        const [_, year, month] = match;
        const partitionDate = new Date(parseInt(year), parseInt(month) - 1);
        if (partitionDate < date) {
          await sql`DROP TABLE IF EXISTS ${sql(tablename)}`;
          console.log(`🗑️ 오래된 파티션 삭제: ${tablename}`);
        }
      }
    }
  } catch (error) {
    console.error('❌ 데이터 정리 실패:', error);
  }
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

export default sql; 