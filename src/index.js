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

    const discoveredData = {
        paths: [],
        jsVariables: [],
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
        } else if (type === 'path') {
            console.log(`Discovered path: ${data.url}`);
            discoveredData.paths.push(data);
        }
    };

    try {
        await browserService.launch();
        await browserService.interceptRequests(gameUrl, onData);

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

        const output = {
            vendor: vendorName,
            gameUrl: gameUrl,
            discoveredPaths: discoveredData.paths.map(p => p.url),
            discoveredVariables: discoveredData.jsVariables,
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
