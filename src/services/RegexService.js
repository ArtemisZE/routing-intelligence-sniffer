class RegexService {
    analyze(jsContent) {
        const candidates = new Map();
        // Regex to find patterns like var.server, var.staticUrl, var.api
        const regex = /([a-zA-Z0-9$_]{1,3})\.(server|staticUrl|api)\b/g;

        let match;
        while ((match = regex.exec(jsContent)) !== null) {
            const variable = match[1];
            const property = match[2];
            const fullMatch = match[0];

            if (!candidates.has(variable)) {
                candidates.set(variable, []);
            }
            candidates.get(variable).push({ property, fullMatch });
        }

        const results = [];
        for (const [variable, properties] of candidates.entries()) {
            results.push({
                variable,
                associations: properties,
            });
        }

        return results;
    }
}

module.exports = RegexService;
