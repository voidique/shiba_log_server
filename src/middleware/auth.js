export const validateApiKey = (req, res, next) => {
  // 기존 Next.js route.ts와 동일한 방식으로 검증
  const apiKey = req.headers['x-api-key'];
  const validKeys = [
    process.env.SHIBA_LOG_API_KEY,
    process.env.SHIBA_LOG_API_KEY2
  ].filter(Boolean);
  
  if (!apiKey) {
    return res.status(401).json({ 
      error: '인증 실패',
      message: 'x-api-key 헤더가 누락되었습니다' 
    });
  }
  
  // 키 로테이션을 위해 두 개의 키를 허용
  if (!validKeys.includes(apiKey)) {
    return res.status(401).json({ 
      error: '인증 실패',
      message: '유효하지 않은 API 키입니다' 
    });
  }
  
  next();
};

export const logRequest = (req, res, next) => {
  const timestamp = new Date().toISOString();
  const { method, url, ip } = req;
  const userAgent = req.headers['user-agent'] || 'Unknown';
  
  // 헬스체크 및 로그 저장/배치 요청은 로깅 제외 (너무 시끄러움)
  if (url.includes('/health') || url === '/api/logs' || url === '/api/logs/batch') {
    return next();
  }
  
  console.log(`📡 [${timestamp}] ${method} ${url} - IP: ${ip} - UA: ${userAgent}`);
  next();
};

export const errorHandler = (err, req, res, next) => {
  console.error('❌ 미들웨어 에러:', err);
  
  res.status(500).json({
    error: '서버 내부 오류',
    message: process.env.NODE_ENV === 'development' ? err.message : '서버에서 오류가 발생했습니다',
    timestamp: new Date().toISOString()
  });
}; 
