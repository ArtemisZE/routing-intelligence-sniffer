class ComparisonService {
    constructor(redisService) {
        this.redisService = redisService;
    }

    async analyzePaths(vendor, newPaths) {
        const existingPaths = await this.redisService.getPaths(vendor);
        const existingUrls = new Set(existingPaths.map(p => p.url));

        const results = {
            static: [],
            dynamic: [],
            new: []
        };
        const suggestions = {
            locationBlocks: new Set(),
            gsubRules: new Set()
        };

        newPaths.forEach(path => {
            const isStatic = this.isStaticPath(path.url);
            if (existingUrls.has(path.url)) {
                if (isStatic) {
                    results.static.push(path.url);
                    suggestions.locationBlocks.add(this.getBasePath(path.url));
                } else {
                    results.dynamic.push(path.url);
                    suggestions.gsubRules.add(this.getDynamicBasePath(path.url));
                }
            } else {
                results.new.push(path.url);
                if (isStatic) {
                    suggestions.locationBlocks.add(this.getBasePath(path.url));
                } else {
                    suggestions.gsubRules.add(this.getDynamicBasePath(path.url));
                }
            }
        });

        return {
            pathAnalysis: results,
            nginxSuggestions: {
                locationBlocks: [...suggestions.locationBlocks],
                gsubRules: [...suggestions.gsubRules]
            }
        };
    }

    isStaticPath(url) {
        // Simple heuristic: if it contains a long number or hash-like string, it's dynamic
        return !/(\d{5,})|([a-fA-F0-9]{16,})/.test(url);
    }

    getBasePath(url) {
        const urlObj = new URL(url);
        // Return up to the first two path segments
        const pathSegments = urlObj.pathname.split('/').filter(p => p);
        return `${urlObj.origin}/${pathSegments.slice(0, 2).join('/')}`;
    }

    getDynamicBasePath(url) {
        const urlObj = new URL(url);
        const pathSegments = urlObj.pathname.split('/').filter(p => p);
        // Find the first dynamic-looking segment and suggest replacement from there
        let dynamicIndex = -1;
        for (let i = 0; i < pathSegments.length; i++) {
            if (!this.isStaticPath(pathSegments[i])) {
                dynamicIndex = i;
                break;
            }
        }
        if (dynamicIndex !== -1) {
            return `location ~* ^/${pathSegments.slice(0, dynamicIndex).join('/')}/ { ... }`;
        }
        return `location ${urlObj.pathname} { ... }`;

    }
}

module.exports = ComparisonService;
