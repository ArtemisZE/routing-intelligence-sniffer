const playwright = require('playwright');
const https = require('https');
const http = require('http');

class BrowserService {
    constructor() {
        this.browser = null;
    }

    async launch() {
        this.browser = await playwright.chromium.launch();
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

        const context = await this.browser.newContext();
        const page = await context.newPage();

        page.on('request', async (request) => {
            const requestUrl = request.url();
            const resourceType = request.resourceType();

            // Ignore common noise
            if (requestUrl.includes('google-analytics.com') || resourceType === 'font') {
                return;
            }

            const headers = request.headers();
            const method = request.method();

            const requestData = {
                url: requestUrl,
                headers: {
                    host: headers['host'],
                    'accept-encoding': headers['accept-encoding'],
                },
                method: method,
            };

            if (requestUrl.endsWith('.js')) {
                try {
                    const jsContent = await this.download(requestUrl);
                    onData('js', { ...requestData, content: jsContent });
                } catch (error) {
                    console.error(`Failed to download ${requestUrl}: ${error.message}`);
                }
            } else if (requestUrl.endsWith('.json') || requestUrl.includes('/ws')) {
                onData('path', requestData);
            }
        });

        await page.goto(url, { waitUntil: 'networkidle' });
        await page.close();
        await context.close();
    }

    download(url) {
        return new Promise((resolve, reject) => {
            const client = url.startsWith('https') ? https : http;
            client.get(url, (res) => {
                let data = '';
                res.on('data', (chunk) => {
                    data += chunk;
                });
                res.on('end', () => {
                    resolve(data);
                });
            }).on('error', (err) => {
                reject(err);
            });
        });
    }
}

module.exports = BrowserService;
