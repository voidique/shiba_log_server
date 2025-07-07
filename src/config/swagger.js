import swaggerJsdoc from 'swagger-jsdoc';

const options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Shiba Log Server API',
      version: '1.0.0',
      description: '시바 로그 수집 서버의 REST API 문서입니다.',
    },
    servers: [
      {
        url: `http://localhost:${process.env.PORT || 3002}`,
        description: '개발 서버'
      }
    ],
    components: {
      securitySchemes: {
        ApiKeyAuth: {
          type: 'apiKey',
          in: 'header',
          name: 'x-api-key',
          description: 'API 키를 x-api-key 헤더에 포함시켜 주세요.'
        }
      },
      schemas: {
        LogEntry: {
          type: 'object',
          required: ['type', 'message'],
          properties: {
            type: {
              type: 'string',
              description: '로그 타입',
              example: 'user_action'
            },
            message: {
              type: 'string',
              description: '로그 메시지',
              example: '사용자가 로그인했습니다'
            },
            level: {
              type: 'string',
              enum: ['debug', 'info', 'warn', 'error'],
              description: '로그 레벨',
              example: 'info',
              default: 'info'
            },
            metadata: {
              type: 'object',
              description: '추가 메타데이터',
              example: {
                userId: 12345,
                sessionId: 'abc123',
                ip: '192.168.1.1'
              }
            }
          }
        },
        BatchLogRequest: {
          type: 'object',
          required: ['logs'],
          properties: {
            logs: {
              type: 'array',
              items: {
                $ref: '#/components/schemas/LogEntry'
              },
              minItems: 1,
              maxItems: 1000,
              description: '로그 배열 (최대 1000개)'
            }
          }
        },
        SuccessResponse: {
          type: 'object',
          properties: {
            success: {
              type: 'boolean',
              example: true
            },
            message: {
              type: 'string',
              example: '작업이 성공적으로 완료되었습니다'
            },
            timestamp: {
              type: 'string',
              format: 'date-time',
              example: '2024-01-01T00:00:00.000Z'
            }
          }
        },
        ErrorResponse: {
          type: 'object',
          properties: {
            error: {
              type: 'string',
              example: '요청 처리 중 오류가 발생했습니다'
            },
            message: {
              type: 'string',
              example: '상세한 오류 메시지'
            }
          }
        },
        LogsQueryResponse: {
          type: 'object',
          properties: {
            success: {
              type: 'boolean',
              example: true
            },
            data: {
              type: 'object',
              properties: {
                memory: {
                  type: 'object',
                  description: '메모리 버퍼의 로그들'
                },
                database: {
                  type: 'object',
                  description: '데이터베이스의 로그들'
                },
                combined: {
                  type: 'object',
                  properties: {
                    totalMemoryLogs: {
                      type: 'integer',
                      description: '메모리 로그 총 개수'
                    },
                    totalDatabaseLogs: {
                      type: 'integer',
                      description: '데이터베이스 로그 총 개수'
                    },
                    bufferSize: {
                      type: 'integer',
                      description: '현재 버퍼 크기'
                    }
                  }
                }
              }
            },
            timestamp: {
              type: 'string',
              format: 'date-time'
            }
          }
        },
        StatsResponse: {
          type: 'object',
          properties: {
            success: {
              type: 'boolean',
              example: true
            },
            data: {
              type: 'object',
              properties: {
                server: {
                  type: 'object',
                  properties: {
                    uptime: {
                      type: 'number',
                      description: '서버 업타임 (초)'
                    },
                    memoryUsage: {
                      type: 'object',
                      description: '메모리 사용량'
                    },
                    nodeVersion: {
                      type: 'string',
                      description: 'Node.js 버전'
                    },
                    environment: {
                      type: 'string',
                      description: '환경 설정'
                    }
                  }
                },
                logStore: {
                  type: 'object',
                  description: '로그 스토어 통계'
                },
                database: {
                  type: 'object',
                  properties: {
                    connectionString: {
                      type: 'string',
                      description: '데이터베이스 연결 상태'
                    }
                  }
                }
              }
            },
            timestamp: {
              type: 'string',
              format: 'date-time'
            }
          }
        },
        HealthResponse: {
          type: 'object',
          properties: {
            status: {
              type: 'string',
              example: 'healthy'
            },
            timestamp: {
              type: 'string',
              format: 'date-time'
            },
            server: {
              type: 'object',
              properties: {
                uptime: {
                  type: 'number',
                  description: '서버 업타임 (초)'
                },
                memory: {
                  type: 'object',
                  description: '메모리 사용량'
                },
                bufferSize: {
                  type: 'integer',
                  description: '현재 버퍼 크기'
                },
                isProcessing: {
                  type: 'boolean',
                  description: '처리 중 여부'
                }
              }
            }
          }
        },
        CleanupRequest: {
          type: 'object',
          properties: {
            months: {
              type: 'integer',
              minimum: 1,
              maximum: 24,
              description: '보관할 개월 수 (1-24)',
              example: 6,
              default: 6
            }
          }
        }
      }
    },
    security: [
      {
        ApiKeyAuth: []
      }
    ]
  },
  apis: ['./src/routes/*.js'] // 라우터 파일 경로
};

export const swaggerSpec = swaggerJsdoc(options); 