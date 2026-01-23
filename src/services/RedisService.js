const Redis = require('ioredis');

class RedisService {
    constructor() {
        this.redis = new Redis(process.env.REDIS_URL);
    }

    async getPaths(vendor) {
        const paths = await this.redis.smembers(`vendor:${vendor}:paths`);
        return paths.map(JSON.parse);
    }

    async addPath(vendor, pathData) {
        await this.redis.sadd(`vendor:${vendor}:paths`, JSON.stringify(pathData));
    }

    async getVariables(vendor) {
        return this.redis.hgetall(`vendor:${vendor}:variables`);
    }

    async addVariable(vendor, variable, association) {
        await this.redis.hset(`vendor:${vendor}:variables`, variable, JSON.stringify(association));
    }

    async disconnect() {
        await this.redis.quit();
    }
}

module.exports = RedisService;
