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

        const mainHost = new URL(url).host;

        // Using 'response' instead of 'request' to capture the actual content 
        // that the browser successfully received.
        page.on('response', async (response) => {
            const request = response.request();
            const requestUrl = request.url();
            const resourceType = request.resourceType();
            const status = response.status();
            const requestHost = new URL(requestUrl).host;

            // Ignore failures and common noise
            if (status < 200 || status >= 400 || requestUrl.includes('google-analytics.com')) {
                return;
            }

            // Only capture requests to the main domain or its subdomains
            if (!requestHost.endsWith(mainHost)) {
                return;
            }

            const headers = request.headers();
            const requestData = {
                url: requestUrl,
                headers: {
                    host: headers['host'],
                    'accept-encoding': headers['accept-encoding'],
                },
                method: request.method(),
            };

            // Detect JS files
            if (resourceType === 'script' || requestUrl.endsWith('.js')) {
                try {
                    // Grab content directly from the browser's memory
                    const jsContent = await response.text();
                    console.log(`>> Captured JS Content: ${requestUrl.substring(0, 80)}...`);
                    onData('js', { ...requestData, content: jsContent });
                } catch (error) {
                    // Some responses (like redirects) can't have their text read
                }
            } 
            // Capture all other relevant API/data requests
            else if (!['document', 'stylesheet', 'image', 'font', 'media'].includes(resourceType)) {
                console.log(`>> Discovered Path: [${resourceType}] ${requestUrl}`);
                onData('path', requestData);
            }
        });

        console.log(`Navigating to: ${url}`);
        
        try {
            // Increased timeout to 60s for slow vendor handshakes
            await page.goto(url, { waitUntil: 'load', timeout: 60000 });
            
            console.log("Page loaded. Waiting 15 seconds for game engine to boot and authenticate...");
            
            // This is the critical "Handshake Wait" for Evoplay/Pragmatic
            await page.waitForTimeout(15000); 
            
            // Optional: Take a screenshot to see what the browser is seeing
            // await page.screenshot({ path: 'last_scan.png' });
            // console.log("Screenshot saved as last_scan.png");

        } catch (error) {
            console.error(`Navigation error: ${error.message}`);
        }

        await page.close();
        await context.close();
    }
}

module.exports = BrowserService;