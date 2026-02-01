const playwright = require('playwright');

class BrowserService {
    constructor() {
        this.browser = null;
    }

    async launch() {
        this.browser = await playwright.chromium.launch({ 
            headless: false,
            args: [
                '--disable-blink-features=AutomationControlled',
                '--use-fake-ui-for-media-stream'
            ]
        });
    }

    async close() {
        if (this.browser) {
            await this.browser.close();
        }
    }

    async interceptRequests(url, onData) {
        if (!this.browser) {
            throw new Error('Browser not launched. Call launch() first.');
        }

        const context = await this.browser.newContext({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        });
        const page = await context.newPage();

        // Store active requests to associate with responses later
        const activeRequests = new Map();

        page.on('request', (request) => {
            const requestUrl = request.url();
            const resourceType = request.resourceType();
            const headers = request.headers();

            // Ignore standard noise
            const IGNORED_DOMAINS = [
                'google-analytics.com', 'googletagmanager.com', 'gstatic.com', 'doubleclick.net'
            ];
            if (IGNORED_DOMAINS.some(domain => requestUrl.includes(domain)) ||
                ['font', 'image', 'media', 'stylesheet'].includes(resourceType)) {
                return;
            }

            const requestData = {
                url: requestUrl,
                headers: {
                    host: headers['host'],
                    'accept-encoding': headers['accept-encoding'],
                },
                method: request.method(),
                resourceType: resourceType,
            };
            activeRequests.set(requestUrl, requestData);
        });

        page.on('response', async (response) => {
            const requestUrl = response.url();
            const status = response.status();
            const requestData = activeRequests.get(requestUrl);
            activeRequests.delete(requestUrl);

            if (!requestData || status < 200 || status >= 400) return;

            const contentType = response.headers()['content-type'] || '';

            if (requestData.resourceType === 'script' || requestUrl.endsWith('.js') || contentType.includes('javascript')) {
                try {
                    const jsContent = await response.text();
                    console.log(`>> Captured JS Content: ${requestUrl.substring(0, 80)}...`);
                    onData('js', { ...requestData, content: jsContent });
                } catch (error) {
                    // Ignore
                }
            } else if (requestUrl.endsWith('.json') || contentType.includes('json') || contentType.includes('text/plain')) {
                try {
                    const content = await response.text();
                    console.log(`>> Captured JSON/Text Content: ${requestUrl.substring(0, 80)}...`);
                    onData('path', { ...requestData, content: content });
                } catch (error) {
                    // Ignore
                }
            } else if (requestUrl.startsWith('ws')) {
                console.log(`>> Discovered WebSocket: ${requestUrl}`);
                onData('path', requestData);
            } else if (!['document'].includes(requestData.resourceType)) {
                console.log(`>> Discovered Path: [${requestData.resourceType}] ${requestUrl}`);
                onData('path', requestData);
            }
        });

        // CRITICAL: Dedicated WebSocket Listener to catch hidden domains like engine.livetables.io
        page.on('websocket', ws => {
            const wsUrl = ws.url();
            console.log(`>> Discovered WebSocket (Event): ${wsUrl}`);
            onData('path', {
                url: wsUrl,
                method: 'GET',
                headers: {},
                resourceType: 'websocket',
                content: '' // WebSockets usually don't have static content to scrape urls from
            });
        });

        console.log(`Navigating to: ${url}`);
        
        try {
            await page.goto(url, { waitUntil: 'load', timeout: 60000 });
            
            const handshakeWaitTime = parseInt(process.env.HANDSHAKE_WAIT_TIME || '60000', 10);
            console.log(`Page loaded. Waiting ${handshakeWaitTime / 1000} seconds for game engine to boot...`);
            await page.waitForTimeout(handshakeWaitTime); 

        } catch (error) {
            console.error(`Navigation error: ${error.message}`);
        }

        await page.close();
        await context.close();
    }
}

module.exports = BrowserService;