const Redis = require('ioredis');

class RedisService {
    constructor() {
        this.redis = new Redis(process.env.REDIS_URL);

        this.redis.on('connect', () => {
            console.log('Connected to Redis successfully');
        });

        this.redis.on('error', (err) => {
            console.error('Redis Connection Error:', err.message);
        });
    }

    async getPaths(vendor) {
        const paths = await this.redis.smembers(`vendor:${vendor}:paths`);
        return paths.map(p => JSON.parse(p));
    }

    async addPath(vendor, pathData) {
        const data = JSON.stringify({
            url: pathData.url,
            method: pathData.method,
            host: pathData.headers.host
        });
        const result = await this.redis.sadd(`vendor:${vendor}:paths`, data);
        console.log(`+ Path saved to Redis: ${result ? 'New' : 'Duplicate'}`);
    }

    async getVariables(vendor) {
        return this.redis.hgetall(`vendor:${vendor}:variables`);
    }

    async addVariable(variable, association, vendor) {
        await this.redis.hset(`vendor:${vendor}:variables`, variable, association);
        console.log(`+ Variable [${variable}] saved to Redis`);
    }

    async disconnect() {
        await this.redis.quit();
    }
}

module.exports = RedisService;
