const Redis = require('ioredis');

const redisConfig = {
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT) || 6379,
  password: process.env.REDIS_PASSWORD || undefined,
  tls: process.env.REDIS_TLS === 'true' ? {} : undefined,
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  // Prevent endless reconnect spam
  retryStrategy(times) {
    if (times > 10) return null; // stop retrying after 10 attempts
    return Math.min(times * 500, 5000); // wait 500ms, 1s, 1.5s... up to 5s
  },
  reconnectOnError(err) {
    // Only reconnect on specific errors
    return err.message.includes('ECONNRESET') || err.message.includes('ETIMEDOUT');
  },
};

let redisClient;

const getRedisClient = () => {
  if (!redisClient) {
    redisClient = new Redis(redisConfig);
    redisClient.on('connect', () => console.log('Redis connected'));
    redisClient.on('error', (err) => {
      // Only log once per error type, not every reconnect attempt
      if (!err.message.includes('ECONNRESET')) {
        console.error('Redis error:', err.message);
      }
    });
  }
  return redisClient;
};

module.exports = { getRedisClient, redisConfig };