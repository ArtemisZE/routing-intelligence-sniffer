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

    async addVariable(vendor, variable, association) {
        await this.redis.hset(`vendor:${vendor}:variables`, variable, association);
    }

    async addDomain(vendor, domain) {
        const result = await this.redis.sadd(`vendor:${vendor}:domains`, domain);
        if (result) console.log(`+ Domain saved to Redis: ${domain}`);
    }

    async getDomains(vendor) {
        return this.redis.smembers(`vendor:${vendor}:domains`);
    }

    async disconnect() {
        await this.redis.quit();
    }
}

module.exports = RedisService;
