
import postgres from 'postgres';
import dotenv from 'dotenv';

dotenv.config();

const dbUrl = process.env.SHIBA_LOG_DATABASE_URL || '';

async function checkIndexes() {
  console.log('🔄 Checking "postgres" database...');
  
  try {
    // DB 이름을 postgres로 강제 변경하여 접속
    const u = new URL(dbUrl);
    u.pathname = '/postgres';
    const adminUrl = u.toString();
    
    const sql = postgres(adminUrl);
    
    // game_logs 테이블이 있는지 확인
    const tables = await sql`
      SELECT tablename FROM pg_tables 
      WHERE tablename = 'game_logs' 
      AND schemaname = 'public'
    `;
    
    if (tables.length > 0) {
      console.log('✅ Found "game_logs" table in "postgres" database!');
      await runChecks(sql);
    } else {
      console.log('❌ "game_logs" table NOT found in "postgres" database.');
      console.log('❓ Please check your SHIBA_LOG_DATABASE_URL environment variable.');
    }
    
    await sql.end();
    
  } catch (error) {
    console.error('❌ Error:', error.message);
  }
}

async function runChecks(sql) {
    console.log('🔍 인덱스 상태 확인 중...');

    // 1. 현재 생성 중인 인덱스 확인
    const progress = await sql`
      SELECT 
        t.relname as table_name,
        i.relname as index_name,
        p.phase,
        p.blocks_total,
        p.blocks_done,
        round(p.blocks_done::numeric / p.blocks_total::numeric * 100, 2) as progress_percent
      FROM pg_stat_progress_create_index p
      JOIN pg_class t ON p.relid = t.oid
      JOIN pg_class i ON p.index_relid = i.oid
    `;

    if (progress.length > 0) {
      console.log('\n⏳ 현재 인덱스 생성 진행 중:');
      console.table(progress);
    } else {
      console.log('\n✅ 현재 생성 중인 인덱스 없음 (완료되었거나 시작되지 않음)');
    }

    // 2. 생성된 FTS 인덱스 확인
    const indexes = await sql`
      SELECT tablename, indexname, indexdef
      FROM pg_indexes
      WHERE indexname LIKE '%_fts'
      ORDER BY tablename
    `;

    if (indexes.length > 0) {
      console.log('\n📦 생성된 FTS 인덱스 목록:');
      indexes.forEach(idx => {
        console.log(`- [${idx.tablename}] ${idx.indexname}`);
      });
    } else {
      console.log('\n❌ FTS 인덱스가 아직 발견되지 않았습니다.');
    }

    // 3. 테이블 크기 확인 (참고용)
    const tableSize = await sql`
      SELECT count(*) as count FROM game_logs
    `;
    console.log(`\n📊 현재 game_logs 데이터 수: ${tableSize[0].count}개`);
}

checkIndexes();
