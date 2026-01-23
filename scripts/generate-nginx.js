require('dotenv').config();
const RedisService = require('../src/services/RedisService');
const fs = require('fs');
const path = require('path');

async function generateConfig() {
    const args = process.argv.slice(2);
    if (args.length !== 2) {
        console.error('Usage: node scripts/generate-nginx.js <vendor_name> <proxy_domain>');
        process.exit(1);
    }

    const [vendor, proxyDomain] = args;
    const redis = new RedisService();

    try {
        const paths = await redis.getPaths(vendor);
        const variables = await redis.getVariables(vendor);

        // Generate the Lua Gsub lines based on Redis variables
        let luaReplacements = "";
        if (variables) {
            Object.entries(variables).forEach(([varName, associationData]) => {
                let associations = JSON.parse(associationData);
                if (typeof associations === 'string') associations = JSON.parse(associations);
                const assocArray = Array.isArray(associations) ? associations : [associations];

                assocArray.forEach(assoc => {
                    // Logic: body = body:gsub('r%.api%s*=%s*["\'][^"\']+["\']', 'r.api = "https://' .. ngx.var.http_host .. '"')
                    const pattern = `${varName}%.${assoc.property}`;
                    luaReplacements += `                -- Detected Variable: ${varName}.${assoc.property}\n`;
                    luaReplacements += `                body = body:gsub('${pattern}%%s*=%%s*["\'][^"\']+["\']', '${varName}.${assoc.property} = "https://' .. ngx.var.http_host .. '"')\n`;
                });
            });
        }

        // Generate Location blocks for discovered API paths
        let apiLocations = "";
        const uniquePaths = [...new Set(paths.map(p => {
            const urlObj = new URL(p.url);
            const parts = urlObj.pathname.split('/');
            return `/${parts[1]}/${parts[2]}`; // e.g., /server/services
        }))];

        uniquePaths.forEach(p => {
            apiLocations += `
        location ${p} {
            proxy_pass https://${proxyDomain};
            proxy_set_header Host ${proxyDomain};
            proxy_set_header X-Forwarded-Proto $scheme;
        }\n`;
        });

        // The Full Template
        const fullConfig = `events {}

http {
    resolver 1.1.1.1 8.8.8.8 valid=60s;

    server {
        listen 8080;
        server_name _;
        server_tokens off;

        proxy_ssl_server_name on;
        proxy_http_version 1.1;

        location = /health {
            default_type text/plain;
            return 200 "ok";
        }

        # Dynamic JS Interceptor for ${vendor}
        location ~* ^/.*\\.js$ {
            content_by_lua_block {
                local http = require "resty.http"
                local httpc = http.new()

                local res, err = httpc:request_uri("https://${proxyDomain}" .. ngx.var.request_uri, {
                    method = "GET",
                    ssl_verify = false,
                    headers = {
                        ["Host"] = "${proxyDomain}",
                        ["Accept-Encoding"] = ""
                    }
                })

                if not res then
                    ngx.status = 502
                    ngx.say("Error fetching resource")
                    return
                end

                local body = res.body

${luaReplacements}
                ngx.header["Content-Type"] = "application/javascript"
                ngx.say(body)
            }
        }

${apiLocations}
        # Default proxy
        location / {
            proxy_pass https://${proxyDomain};
            proxy_set_header Host ${proxyDomain};
            proxy_set_header X-Forwarded-Proto $scheme;
        }
    }
}
`;

        const outputDir = path.join(__dirname, '../output', vendor);
        if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
        fs.writeFileSync(path.join(outputDir, `nginx.conf`), fullConfig);

        console.log(`Success! Generated full nginx.conf in: ${outputDir}`);

    } catch (error) {
        console.error('Generation failed:', error);
    } finally {
        await redis.disconnect();
    }
}

generateConfig();