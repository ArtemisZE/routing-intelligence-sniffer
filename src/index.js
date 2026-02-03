require('dotenv').config();
const BrowserService = require('./services/BrowserService');
const RegexService = require('./services/RegexService');
const RedisService = require('./services/RedisService');
const ComparisonService = require('./services/ComparisonService');

async function main() {
    const args = process.argv.slice(2);
    if (args.length !== 2) {
        console.error('Usage: node src/index.js <vendor_name> <game_url>');
        process.exit(1);
    }

    const [vendorName, gameUrl] = args;
    console.log(`Scanning ${gameUrl} for vendor ${vendorName}...`);

    const browserService = new BrowserService();
    const regexService = new RegexService();
    const redisService = new RedisService();
    const comparisonService = new ComparisonService(redisService);

    // Save metadata (Primary Domain & Original Domain)
    try {
        const originalDomain = new URL(gameUrl).hostname;
        await redisService.redis.hset(`vendor:${vendorName}:metadata`, 'primaryDomain', originalDomain);
        await redisService.redis.hset(`vendor:${vendorName}:metadata`, 'originalDomain', originalDomain);
        console.log(`Saved Primary/Original Domain to Redis: ${originalDomain}`);
    } catch (e) {
        console.error("Invalid Game URL, could not determine primary domain.");
    }

    const discoveredData = {
        paths: [],
        jsVariables: [],
        domains: new Set()
    };

    const onData = (type, data) => {
        if (type === 'js') {
            console.log(`Analyzing JS file: ${data.url}`);
            const variables = regexService.analyze(data.content);
            if (variables.length > 0) {
                discoveredData.jsVariables.push({
                    file: data.url,
                    variables,
                });
            }
            // Discover hidden domains in JS content
            const urls = regexService.extractUrls(data.content);
            urls.forEach(u => discoveredData.domains.add(u));
            
        } else if (type === 'path') {
            console.log(`Discovered path: ${data.url}`);
            discoveredData.paths.push(data);
            try {
                discoveredData.domains.add(new URL(data.url).hostname);
            } catch(e){}
            
            // CRITICAL: Scan JSON/API responses for hidden domains (like engine.livetables.io)
            if (data.content) {
                const urls = regexService.extractUrls(data.content);
                urls.forEach(u => discoveredData.domains.add(u));
            }
        }
    };

    try {
        await browserService.launch();
        const finalUrl = await browserService.interceptRequests(gameUrl, onData);

        // Capture Redirects
        if (finalUrl) {
            const finalDomain = new URL(finalUrl).hostname;
            const originalDomain = new URL(gameUrl).hostname;
            
            await redisService.redis.hset(`vendor:${vendorName}:metadata`, 'finalDomain', finalDomain);
            
            if (finalDomain !== originalDomain) {
                console.log(`ℹRedirect Detected: ${originalDomain} -> ${finalDomain}`);
                console.log(`Saved 'finalDomain' to Redis for advanced routing.`);
            }
        }

        const pathAnalysis = await comparisonService.analyzePaths(vendorName, discoveredData.paths);

        // Save new data to Redis
        for (const path of discoveredData.paths) {
            await redisService.addPath(vendorName, path);
        }
        for (const jsFile of discoveredData.jsVariables) {
            for (const variable of jsFile.variables) {
                await redisService.addVariable(vendorName, variable.variable, JSON.stringify(variable.associations));
            }
        }
        for (const domain of discoveredData.domains) {
            await redisService.addDomain(vendorName, domain);
        }

        const output = {
            vendor: vendorName,
            gameUrl: gameUrl,
            discoveredPaths: discoveredData.paths.map(p => p.url),
            discoveredVariables: discoveredData.jsVariables,
            discoveredDomains: [...discoveredData.domains],
            analysis: pathAnalysis,
        };

        console.log(JSON.stringify(output, null, 2));

    } catch (error) {
        console.error('An error occurred:', error);
    } finally {
        await browserService.close();
        await redisService.disconnect();
    }
}

main();
