import postgres from 'postgres';
import dotenv from 'dotenv';

dotenv.config();

const sql = postgres(process.env.SHIBA_LOG_DATABASE_URL || '', {
  max: 1,
  idle_timeout: 10,
});

const PARTITIONED_TABLE_NAME = 'game_logs_partitioned';

async function fixIndexes() {
  console.log('🔧 인덱스 복구 도구 시작...');

  try {
    // 1. 유효하지 않은 인덱스 찾기
    console.log('🔍 유효하지 않은 인덱스 검색 중...');
    const invalidIndexes = await sql`
      SELECT 
        n.nspname as schemaname,
        c.relname as indexname,
        t.relname as tablename
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
      JOIN pg_class t ON t.oid = i.indrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE i.indisvalid = false
      AND t.relname LIKE 'game_logs%'
    `;

    if (invalidIndexes.length > 0) {
      console.log(`⚠️ 발견된 유효하지 않은 인덱스: ${invalidIndexes.length}개`);
      for (const idx of invalidIndexes) {
        console.log(`   - ${idx.indexname} (Table: ${idx.tablename})`);
        
        console.log(`🗑️ 삭제 중: ${idx.indexname}...`);
        await sql.unsafe(`DROP INDEX IF EXISTS ${idx.schemaname}.${idx.indexname}`);
        console.log('   ✅ 삭제 완료');
      }
    } else {
      console.log('✨ 유효하지 않은 인덱스가 없습니다.');
    }

    // 2. 파티션 테이블 인덱스 재생성 확인
    console.log('\n🔄 파티션 인덱스 상태 확인 및 생성...');
    
    // 11월 파티션 확인 (사용자가 문제 겪은 파티션)
    const partitions = await sql`
      SELECT tablename 
      FROM pg_tables 
      WHERE tablename LIKE ${PARTITIONED_TABLE_NAME + '%'}
      ORDER BY tablename DESC
    `;

    for (const partition of partitions) {
      const pName = partition.tablename;
      console.log(`\n📦 파티션 점검: ${pName}`);

      const indexNames = {
        trgm: `idx_${pName}_message_trgm`,
        type_level: `idx_${pName}_type_level`,
        created_at: `idx_${pName}_created_at`
      };

      // GIN 인덱스 확인
      await createIndexIfNotExists(pName, indexNames.trgm, 'USING GIN (message gin_trgm_ops)');
      // 복합 인덱스 확인
      await createIndexIfNotExists(pName, indexNames.type_level, '(type, level)');
      // 시간 인덱스 확인
      await createIndexIfNotExists(pName, indexNames.created_at, '(created_at)');
    }

    console.log('\n✅ 모든 작업 완료!');
    process.exit(0);

  } catch (error) {
    console.error('❌ 에러 발생:', error);
    process.exit(1);
  }
}

async function createIndexIfNotExists(tableName, indexName, definition) {
  // 인덱스 존재 여부 확인 (유효한 것만)
  const exists = await sql`
    SELECT 1
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = ${indexName}
  `;

  if (exists.length > 0) {
    console.log(`   ✅ 인덱스 존재함: ${indexName}`);
    return;
  }

  console.log(`   ⏳ 인덱스 생성 시작: ${indexName}`);
  console.log(`      (데이터 양에 따라 시간이 걸릴 수 있습니다...)`);
  
  const start = Date.now();
  // CONCURRENTLY 사용 안함 (스크립트에서 직접 돌리므로 확실하게 기다림)
  await sql.unsafe(`CREATE INDEX ${indexName} ON ${tableName} ${definition}`);
  const duration = ((Date.now() - start) / 1000).toFixed(1);
  
  console.log(`   🎉 생성 완료 (${duration}초)`);
}

fixIndexes();
