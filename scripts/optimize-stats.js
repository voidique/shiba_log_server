import postgres from 'postgres';
import dotenv from 'dotenv';

dotenv.config();

const sql = postgres(process.env.SHIBA_LOG_DATABASE_URL || '', {
  max: 1,
  idle_timeout: 10,
});

async function optimizeStats() {
  console.log('📊 데이터베이스 통계 업데이트(ANALYZE) 시작...');
  console.log('   - 인덱스를 새로 만들면 통계를 업데이트해야 DB가 인덱스를 사용합니다.');

  try {
    // 1. 파티션 테이블 목록 조회
    const partitions = await sql`
      SELECT tablename 
      FROM pg_tables 
      WHERE tablename LIKE 'game_logs%'
      AND schemaname = 'public'
      ORDER BY tablename DESC
    `;

    console.log(`📋 총 ${partitions.length}개 테이블에 대해 분석 수행`);

    for (const partition of partitions) {
      const tableName = partition.tablename;
      process.stdout.write(`   Running ANALYZE on ${tableName}... `);
      
      const start = Date.now();
      await sql.unsafe(`ANALYZE ${tableName}`);
      const duration = ((Date.now() - start) / 1000).toFixed(1);
      
      console.log(`✅ 완료 (${duration}초)`);
    }

    console.log('\n✨ 모든 통계 업데이트 완료! 이제 검색 속도가 빨라질 것입니다.');
    process.exit(0);

  } catch (error) {
    console.error('\n❌ 에러 발생:', error);
    process.exit(1);
  }
}

optimizeStats();
