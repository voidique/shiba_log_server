#!/usr/bin/env node

import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';

dotenv.config();

const execAsync = promisify(exec);

// 백업 디렉토리 생성
const backupDir = path.join(process.cwd(), 'backups');
if (!fs.existsSync(backupDir)) {
  fs.mkdirSync(backupDir, { recursive: true });
}

// 데이터베이스 URL 파싱
function parseDbUrl(url) {
  const urlObj = new URL(url);
  return {
    user: urlObj.username,
    password: urlObj.password,
    host: urlObj.hostname,
    port: urlObj.port || 5432,
    database: urlObj.pathname.slice(1) // '/' 제거
  };
}

async function createDatabaseDump() {
  try {
    const dbUrl = process.env.SHIBA_LOG_DATABASE_URL;
    if (!dbUrl) {
      throw new Error('SHIBA_LOG_DATABASE_URL 환경변수가 설정되지 않았습니다.');
    }

    const dbConfig = parseDbUrl(dbUrl);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').split('T')[0];
    const backupFileName = `shiba-logs-backup-${timestamp}.sql`;
    const backupPath = path.join(backupDir, backupFileName);

    console.log('🚀 데이터베이스 백업 시작...');
    console.log(`📍 데이터베이스: ${dbConfig.database}`);
    console.log(`📁 백업 파일: ${backupPath}`);

    // pg_dump 명령어 구성
    const pgDumpCommand = [
      'pg_dump',
      `-h ${dbConfig.host}`,
      `-p ${dbConfig.port}`,
      `-U ${dbConfig.user}`,
      '-d', dbConfig.database,
      '--verbose',
      '--clean',              // DROP 문 포함
      '--if-exists',          // IF EXISTS 추가
      '--no-owner',           // 소유자 정보 제외
      '--no-privileges',      // 권한 정보 제외
      '--format=plain',       // 일반 SQL 형식
      '--encoding=UTF8',      // UTF-8 인코딩
      '>', `"${backupPath}"`
    ].join(' ');

    // 비밀번호 환경변수로 설정
    const env = {
      ...process.env,
      PGPASSWORD: dbConfig.password
    };

    // 덤프 실행
    console.log('⏳ 덤프 생성 중...');
    const { stdout, stderr } = await execAsync(pgDumpCommand, { env });
    
    if (stderr && !stderr.includes('NOTICE')) {
      console.warn('⚠️ 경고:', stderr);
    }

    // 파일 크기 확인
    const stats = fs.statSync(backupPath);
    const fileSizeInMB = (stats.size / 1024 / 1024).toFixed(2);

    console.log('✅ 백업 완료!');
    console.log(`📊 파일 크기: ${fileSizeInMB} MB`);
    console.log(`📂 저장 위치: ${backupPath}`);

    return backupPath;

  } catch (error) {
    console.error('❌ 백업 실패:', error.message);
    throw error;
  }
}

// 압축된 커스텀 형태 덤프도 생성
async function createCustomDump() {
  try {
    const dbUrl = process.env.SHIBA_LOG_DATABASE_URL;
    const dbConfig = parseDbUrl(dbUrl);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').split('T')[0];
    const backupFileName = `shiba-logs-backup-${timestamp}.dump`;
    const backupPath = path.join(backupDir, backupFileName);

    console.log('🗜️  압축 덤프 생성 중...');

    const pgDumpCommand = [
      'pg_dump',
      `-h ${dbConfig.host}`,
      `-p ${dbConfig.port}`,
      `-U ${dbConfig.user}`,
      '-d', dbConfig.database,
      '--verbose',
      '--clean',
      '--if-exists',
      '--no-owner',
      '--no-privileges',
      '--format=custom',      // 커스텀 압축 형식
      '--compress=9',         // 최대 압축
      '--encoding=UTF8',
      '-f', `"${backupPath}"`
    ].join(' ');

    const env = {
      ...process.env,
      PGPASSWORD: dbConfig.password
    };

    await execAsync(pgDumpCommand, { env });

    const stats = fs.statSync(backupPath);
    const fileSizeInMB = (stats.size / 1024 / 1024).toFixed(2);

    console.log('✅ 압축 덤프 완료!');
    console.log(`📊 압축 파일 크기: ${fileSizeInMB} MB`);
    console.log(`📂 저장 위치: ${backupPath}`);

    return backupPath;

  } catch (error) {
    console.error('❌ 압축 덤프 실패:', error.message);
    throw error;
  }
}

// 메인 함수
async function main() {
  try {
    console.log('🏁 Shiba Log Database Backup 시작');
    
    // SQL 덤프 생성
    await createDatabaseDump();
    
    // 압축 덤프 생성
    await createCustomDump();
    
    console.log('');
    console.log('🎉 모든 백업이 완료되었습니다!');
    console.log('📋 복원 방법:');
    console.log('   SQL 파일: psql -U username -d database_name < backup.sql');
    console.log('   압축 파일: pg_restore -U username -d database_name backup.dump');
    
  } catch (error) {
    console.error('💥 백업 프로세스 실패:', error);
    process.exit(1);
  }
}

// 스크립트 직접 실행시
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
} 