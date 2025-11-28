import postgres from 'postgres';
import dotenv from 'dotenv';

dotenv.config();

const sql = postgres(process.env.SHIBA_LOG_DATABASE_URL || '', {
  max: 1,
  idle_timeout: 10,
});

const searchTerm = process.argv[2] || 'error';

async function debugSearch() {
  console.log(`🔍 검색어 '${searchTerm}'에 대한 쿼리 플랜 분석 중...`);

  try {
    const currentTable = 'game_logs_partitioned_2025_11'; // 최신 파티션 가정
    
    console.log(`\n--- Query Plan ---`);
    const result = await sql.unsafe(`
      EXPLAIN ANALYZE
      SELECT *
      FROM ${currentTable}
      WHERE message ILIKE '%${searchTerm}%'
      ORDER BY created_at DESC, logged_at DESC
      LIMIT 50
    `);

    result.forEach(row => {
      console.log(row['QUERY PLAN']);
    });

    console.log(`\n------------------`);
    process.exit(0);

  } catch (error) {
    console.error('❌ 에러 발생:', error);
    process.exit(1);
  }
}

debugSearch();
